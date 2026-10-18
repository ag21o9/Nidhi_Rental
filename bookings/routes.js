import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { prisma } from '../database/client.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'

const router = Router()

function isValidRating(value) {
  return Number.isInteger(value) && value >= 1 && value <= 5
}

function reviewResponse(review) {
  return {
    ...review,
    user: review.user ? {
      id: review.user.id,
      name: review.user.name,
    } : undefined,
  }
}

router.post('/', requireAuth, async (req, res) => {
  const {
    vehicleId, bookingType = 'DAILY', driverOption = 'SELF_DRIVE',
    startDate, endDate, startTime, endTime, durationHours,
    pickupLocation, dropLocation, purpose,
  } = req.body

  if (!vehicleId || !startDate || !endDate || !pickupLocation || !dropLocation) {
    return res.status(400).json({ message: 'vehicleId, startDate, endDate, pickupLocation and dropLocation are required' })
  }

  const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } })
  if (!vehicle || !vehicle.available) {
    return res.status(404).json({ message: 'Available vehicle not found' })
  }

  const vehicleRental = bookingType === 'HOURLY'
    ? (vehicle.hourlyPrice || 0) * (durationHours || 1)
    : vehicle.dailyPrice || 0
  const driverCharges = driverOption === 'WITH_DRIVER' ? 0 : 0
  const taxes = 0
  const totalAmount = vehicleRental + driverCharges + taxes

  const booking = await prisma.$transaction(async (transaction) => {
    const created = await transaction.booking.create({
      data: {
        bookingNumber: `NR-${randomUUID().slice(0, 8).toUpperCase()}`,
        userId: req.user.id,
        vehicleId,
        bookingType,
        driverOption,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        startTime,
        endTime,
        durationHours,
        pickupLocationJson: pickupLocation,
        dropLocationJson: dropLocation,
        purpose,
        vehicleRental,
        driverCharges,
        taxes,
        totalAmount,
        advanceAmount: 0,
        remainingAmount: totalAmount,
        status: 'PENDING',
      },
      include: { vehicle: true },
    })

    await transaction.bookingStatusHistory.create({
      data: {
        bookingId: created.id,
        toStatus: 'PENDING',
        changedByType: 'USER',
        changedById: req.user.id,
      },
    })
    return created
  })

  return res.status(201).json({ booking })
})

router.get('/mine', requireAuth, async (req, res) => {
  const bookings = await prisma.booking.findMany({
    where: { userId: req.user.id },
    include: { vehicle: true, statusHistory: { orderBy: { createdAt: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  })
  return res.json({ bookings })
})

router.get('/reviews', async (req, res) => {
  const { vehicleId } = req.query

  if (!vehicleId || typeof vehicleId !== 'string') {
    return res.status(400).json({ message: 'vehicleId is required' })
  }

  const reviews = await prisma.review.findMany({
    where: { booking: { vehicleId } },
    include: {
      user: { select: { id: true, name: true } },
      booking: { select: { id: true, bookingNumber: true, vehicleId: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  return res.json({ reviews: reviews.map(reviewResponse) })
})

router.get('/reviews/mine', requireAuth, async (req, res) => {
  const reviews = await prisma.review.findMany({
    where: { userId: req.user.id },
    select: {
      id: true,
      vehicleRating: true,
      driverRating: true,
      serviceRating: true,
      comment: true,
      createdAt: true,
      updatedAt: true,
      booking: {
        select: {
          id: true,
          bookingNumber: true,
          bookingType: true,
          driverOption: true,
          startDate: true,
          endDate: true,
          startTime: true,
          endTime: true,
          status: true,
          vehicle: {
            select: {
              id: true,
              brand: true,
              name: true,
              model: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  return res.json({ reviews })
})

router.get('/:id', requireAuth, async (req, res) => {
  const booking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: {
      vehicle: true,
      statusHistory: { orderBy: { createdAt: 'asc' } },
      review: true,
    },
  })

  if (!booking) {
    return res.status(404).json({ message: 'Booking not found' })
  }
  if (booking.userId !== req.user.id && req.user.role !== 'ADMIN') {
    return res.status(403).json({ message: 'You are not allowed to view this booking' })
  }

  return res.json({ booking })
})

router.post('/:id/review', requireAuth, async (req, res) => {
  const {
    vehicleRating, driverRating, serviceRating, comment,
  } = req.body

  if (!isValidRating(vehicleRating) || !isValidRating(serviceRating)) {
    return res.status(400).json({ message: 'vehicleRating and serviceRating must be whole numbers from 1 to 5' })
  }
  if (driverRating !== undefined && driverRating !== null && !isValidRating(driverRating)) {
    return res.status(400).json({ message: 'driverRating must be a whole number from 1 to 5' })
  }
  if (comment !== undefined && comment !== null && typeof comment !== 'string') {
    return res.status(400).json({ message: 'comment must be a string' })
  }

  const booking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: { review: true },
  })

  if (!booking) {
    return res.status(404).json({ message: 'Booking not found' })
  }
  if (booking.userId !== req.user.id) {
    return res.status(403).json({ message: 'Only the booking owner can submit a review' })
  }
  if (booking.status !== 'COMPLETED') {
    return res.status(409).json({ message: 'Reviews can only be submitted for completed bookings' })
  }
  if (booking.review) {
    return res.status(409).json({ message: 'A review already exists for this booking' })
  }

  const review = await prisma.review.create({
    data: {
      bookingId: booking.id,
      userId: req.user.id,
      vehicleRating,
      driverRating: driverRating ?? null,
      serviceRating,
      comment: comment ?? null,
    },
    include: {
      user: { select: { id: true, name: true } },
      booking: { select: { id: true, bookingNumber: true, vehicleId: true } },
    },
  })

  return res.status(201).json({ review: reviewResponse(review) })
})

router.get('/:id/review', async (req, res) => {
  const review = await prisma.review.findUnique({
    where: { bookingId: req.params.id },
    include: {
      user: { select: { id: true, name: true } },
      booking: { select: { id: true, bookingNumber: true, vehicleId: true } },
    },
  })

  if (!review) {
    return res.status(404).json({ message: 'Review not found' })
  }

  return res.json({ review: reviewResponse(review) })
})

router.delete('/:id/review', requireAuth, async (req, res) => {
  const review = await prisma.review.findUnique({
    where: { bookingId: req.params.id },
  })

  if (!review) {
    return res.status(404).json({ message: 'Review not found' })
  }
  if (review.userId !== req.user.id && req.user.role !== 'ADMIN') {
    return res.status(403).json({ message: 'Only the review owner or an admin can delete this review' })
  }

  await prisma.review.delete({ where: { id: review.id } })
  return res.json({ message: 'Review deleted successfully' })
})

router.get('/admin', requireAuth, requireAdmin, async (req, res) => {
  const bookings = await prisma.booking.findMany({
    include: { user: true, vehicle: true, statusHistory: { orderBy: { createdAt: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  })
  return res.json({ bookings })
})

router.patch('/:id/confirm', requireAuth, requireAdmin, async (req, res) => {
  const booking = await prisma.$transaction(async (transaction) => {
    const current = await transaction.booking.findUnique({ where: { id: req.params.id } })
    if (!current) {
      const error = new Error('Booking not found')
      error.statusCode = 404
      throw error
    }
    if (current.status !== 'PENDING') {
      const error = new Error('Only pending bookings can be confirmed')
      error.statusCode = 409
      throw error
    }

    const updated = await transaction.booking.update({
      where: { id: current.id },
      data: { status: 'CONFIRMED' },
      include: { user: true, vehicle: true },
    })
    await transaction.bookingStatusHistory.create({
      data: {
        bookingId: current.id,
        fromStatus: current.status,
        toStatus: 'CONFIRMED',
        changedByType: 'ADMIN',
        changedById: req.user.id,
      },
    })
    return updated
  })

  return res.json({ booking })
})

export default router

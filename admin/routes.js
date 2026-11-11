import { Router } from 'express'
import { randomInt, randomUUID } from 'node:crypto'
import { Prisma } from '../generated/prisma/client.js'
import { prisma } from '../database/client.js'
import { createToken, requireAdminOrStaff, requireAuth } from '../middleware/auth.js'
import { parseBookingPricing } from '../bookings/pricing.js'

const router = Router()
const bookingStatuses = ['PENDING', 'PAYMENT_PENDING', 'CONFIRMED', 'DRIVER_ASSIGNED', 'READY_FOR_PICKUP', 'ONGOING', 'COMPLETED', 'CANCELLED', 'REFUND_PENDING', 'REFUNDED']
const changedByTypes = ['ADMIN', 'STAFF']
const driverStatuses = ['AVAILABLE', 'ASSIGNED', 'ON_TRIP', 'OFFLINE', 'SUSPENDED']
const categories = ['SEDAN', 'SUV', 'LUXURY', 'MUV', 'HATCHBACK', 'TEMPO_TRAVELLER', 'BUS']
const bookingTypes = ['HOURLY', 'DAILY', 'EVENT', 'OUTSTATION']
const driverOptions = ['SELF_DRIVE', 'WITH_DRIVER']

function publicUser(user) {
  const { passwordHash, ...safeUser } = user
  return safeUser
}

function numberQuery(value, fallback, maximum) {
  const parsed = Number(value ?? fallback)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : null
}

function bookingInclude() {
  return {
    user: true,
    vehicle: { include: { images: true, features: true, pickupHub: true } },
    driver: true,
    payments: { include: { refund: true }, orderBy: { createdAt: 'desc' } },
    refund: true,
    statusHistory: { orderBy: { createdAt: 'asc' } },
    messages: { orderBy: { createdAt: 'asc' }, include: { senderUser: true } },
  }
}

function dateWithTime(date, time, fallbackHour = 0) {
  const value = new Date(date)
  if (!time) {
    value.setUTCHours(fallbackHour, 0, 0, 0)
    return value
  }
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time)
  if (!match) return null
  value.setUTCHours(Number(match[1]), Number(match[2]), 0, 0)
  return value
}

function bookingInterval(booking) {
  const start = dateWithTime(booking.startDate, booking.startTime)
  const end = booking.endTime
    ? dateWithTime(booking.endDate, booking.endTime)
    : dateWithTime(new Date(new Date(booking.endDate).getTime() + 86400000), null)
  return start && end && start < end ? { start, end } : null
}

function overlaps(first, second) {
  return second && first.start < second.end && first.end > second.start
}

function routeError(message, statusCode) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

router.post('/login', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) {
    return res.status(400).json({ message: 'email and password are required' })
  }

  const user = await prisma.user.findUnique({ where: { email } })
  if (!user || !['ADMIN', 'STAFF'].includes(user.role) || user.passwordHash !== password || user.status !== 'ACTIVE') {
    return res.status(401).json({ message: 'Invalid admin credentials' })
  }
  return res.json({ user: publicUser(user), token: createToken(user) })
})

router.use(requireAuth, requireAdminOrStaff)

router.post('/bookings', async (req, res) => {
  const request = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  const {
    vehicleId,
    bookingType = 'DAILY',
    driverOption = 'SELF_DRIVE',
    startDate,
    endDate,
    startTime,
    endTime,
    durationHours,
    pickupLocation,
    dropLocation,
    purpose,
    pricing: pricingInput,
  } = request
  const customer = request.customer || {}
  const customerName = typeof customer.name === 'string' ? customer.name.trim() : ''
  const customerEmail = typeof customer.email === 'string' ? customer.email.trim().toLowerCase() : ''
  const customerPhone = typeof customer.phone === 'string' ? customer.phone.trim() : ''
  const pricing = parseBookingPricing(pricingInput)

  if (!customerName || !customerEmail || !customerPhone || !vehicleId || !startDate || !endDate || !pickupLocation || !dropLocation) {
    return res.status(400).json({ message: 'customer name, email and phone, vehicleId, dates, pickup/drop locations, and pricing are required' })
  }
  if (!/^\S+@\S+\.\S+$/.test(customerEmail)) {
    return res.status(400).json({ message: 'customer.email must be a valid email address' })
  }
  if (!bookingTypes.includes(bookingType) || !driverOptions.includes(driverOption)) {
    return res.status(400).json({ message: 'Invalid bookingType or driverOption' })
  }
  if (durationHours !== undefined && (!Number.isInteger(durationHours) || durationHours < 1)) {
    return res.status(400).json({ message: 'durationHours must be a positive whole number' })
  }
  if (purpose !== undefined && typeof purpose !== 'string') {
    return res.status(400).json({ message: 'purpose must be a string' })
  }
  if (!pricing) {
    return res.status(400).json({ message: 'A positive vehicleRental and valid non-negative charges, taxes, discount, and advanceAmount are required' })
  }

  const bookingStart = new Date(startDate)
  const bookingEnd = new Date(endDate)
  if (Number.isNaN(bookingStart.getTime()) || Number.isNaN(bookingEnd.getTime()) || bookingStart > bookingEnd) {
    return res.status(400).json({ message: 'startDate and endDate must be valid dates, and startDate must not be after endDate' })
  }
  const requestedInterval = bookingInterval({ startDate: bookingStart, endDate: bookingEnd, startTime, endTime })
  if (!requestedInterval) {
    return res.status(400).json({ message: 'startTime and endTime must use HH:mm format and define a valid time range' })
  }
  if (typeof pickupLocation !== 'object' || Array.isArray(pickupLocation) || typeof dropLocation !== 'object' || Array.isArray(dropLocation)) {
    return res.status(400).json({ message: 'pickupLocation and dropLocation must be objects' })
  }

  try {
    const result = await prisma.$transaction(async (transaction) => {
      const vehicle = await transaction.vehicle.findUnique({ where: { id: vehicleId } })
      if (!vehicle || !vehicle.available) {
        throw routeError('Available vehicle not found', 404)
      }

      const candidateBookings = await transaction.booking.findMany({
        where: {
          vehicleId,
          startDate: { lte: bookingEnd },
          endDate: { gte: bookingStart },
          status: { notIn: ['CANCELLED', 'REFUNDED'] },
        },
        select: { bookingNumber: true, startDate: true, endDate: true, startTime: true, endTime: true },
      })
      const conflictingBooking = candidateBookings.find((candidate) => overlaps(requestedInterval, bookingInterval(candidate)))
      const candidateBlocks = await transaction.vehicleAvailability.findMany({
        where: { vehicleId, startAt: { lt: requestedInterval.end }, endAt: { gt: requestedInterval.start } },
        select: { reason: true, startAt: true, endAt: true },
      })
      const conflictingBlock = candidateBlocks.find((block) => overlaps(requestedInterval, block))
      if (conflictingBooking || conflictingBlock) {
        const description = conflictingBooking
          ? `booking ${conflictingBooking.bookingNumber}`
          : `availability block${conflictingBlock.reason ? ` (${conflictingBlock.reason})` : ''}`
        throw routeError(`Vehicle is not available because of an existing ${description}`, 409)
      }

      const matchedUsers = await transaction.user.findMany({
        where: { OR: [{ email: customerEmail }, { phone: customerPhone }] },
        select: { id: true, name: true, email: true, phone: true, status: true },
      })
      const emailMatch = matchedUsers.find((user) => user.email === customerEmail)
      const phoneMatch = matchedUsers.find((user) => user.phone === customerPhone)
      if ((emailMatch && phoneMatch && emailMatch.id !== phoneMatch.id)
        || (emailMatch && emailMatch.phone !== customerPhone)
        || (phoneMatch && phoneMatch.email !== customerEmail)) {
        throw routeError('The customer email and phone must belong to the same account', 409)
      }

      let customerAccount = emailMatch || phoneMatch
      let temporaryPassword
      if (customerAccount && customerAccount.status !== 'ACTIVE') {
        throw routeError('The customer account is not active', 409)
      }
      if (!customerAccount) {
        temporaryPassword = String(randomInt(100000, 1000000))
        customerAccount = await transaction.user.create({
          data: {
            name: customerName,
            email: customerEmail,
            phone: customerPhone,
            passwordHash: temporaryPassword,
          },
          select: { id: true, name: true, email: true, phone: true, status: true },
        })
      }

      const booking = await transaction.booking.create({
        data: {
          bookingNumber: `NR-${randomUUID().slice(0, 8).toUpperCase()}`,
          userId: customerAccount.id,
          vehicleId,
          bookingType,
          driverOption,
          startDate: bookingStart,
          endDate: bookingEnd,
          startTime,
          endTime,
          durationHours,
          pickupLocationJson: pickupLocation,
          dropLocationJson: dropLocation,
          purpose,
          ...pricing,
          status: 'CONFIRMED',
        },
        include: {
          user: { select: { id: true, name: true, email: true, phone: true } },
          vehicle: true,
        },
      })

      await transaction.bookingStatusHistory.create({
        data: {
          bookingId: booking.id,
          toStatus: 'CONFIRMED',
          changedByType: req.user.role,
          changedById: req.user.id,
          reason: 'Booked directly by admin or staff',
        },
      })

      return { booking, temporaryPassword }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

    return res.status(201).json({
      booking: result.booking,
      customerCreated: Boolean(result.temporaryPassword),
      ...(result.temporaryPassword && { temporaryPassword: result.temporaryPassword }),
    })
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message })
    }
    if (error.code === 'P2034') {
      return res.status(409).json({ message: 'The vehicle was booked concurrently. Please retry.' })
    }
    if (error.code === 'P2002') {
      return res.status(409).json({ message: 'An account already exists with this customer email or phone' })
    }
    throw error
  }
})

router.get('/analytics/overview', async (req, res) => {
  const range = typeof req.query.range === 'string' && /^\d+d$/.test(req.query.range) ? Number.parseInt(req.query.range, 10) : 7
  const since = new Date(Date.now() - range * 24 * 60 * 60 * 1000)
  const [revenue, activeTrips, pendingBookings, fleet, totalVehicles, statuses] = await Promise.all([
    prisma.payment.aggregate({ where: { status: 'SUCCEEDED', createdAt: { gte: since } }, _sum: { amount: true } }),
    prisma.booking.count({ where: { status: 'ONGOING' } }),
    prisma.booking.count({ where: { status: { in: ['PENDING', 'PAYMENT_PENDING'] } } }),
    prisma.vehicle.count({ where: { available: true } }),
    prisma.vehicle.count(),
    prisma.bookingStatusHistory.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true, toStatus: true },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  const revenueTrend = await prisma.payment.groupBy({
    by: ['createdAt'],
    where: { status: 'SUCCEEDED', createdAt: { gte: since } },
    _sum: { amount: true },
    orderBy: { createdAt: 'asc' },
  })
  const categoryBreakdown = await prisma.vehicle.groupBy({
    by: ['category'],
    _count: { _all: true },
    orderBy: { category: 'asc' },
  })

  return res.json({
    todayRevenue: revenue._sum.amount || 0,
    activeTrips,
    pendingBookings,
    fleetUtilization: totalVehicles ? fleet / totalVehicles : 0,
    revenueTrend: revenueTrend.map((item) => ({ date: item.createdAt, amount: item._sum.amount || 0 })),
    categoryBreakdown,
    statusEvents: statuses,
  })
})

router.get('/analytics/live-feed', async (_req, res) => {
  const [statusHistory, messages, payments] = await Promise.all([
    prisma.bookingStatusHistory.findMany({ take: 25, orderBy: { createdAt: 'desc' }, include: { booking: { select: { id: true, bookingNumber: true } } } }),
    prisma.bookingMessage.findMany({ take: 25, orderBy: { createdAt: 'desc' }, include: { booking: { select: { id: true, bookingNumber: true } } } }),
    prisma.payment.findMany({ take: 25, orderBy: { createdAt: 'desc' }, select: { id: true, bookingId: true, status: true, amount: true, createdAt: true } }),
  ])
  const events = [
    ...statusHistory.map((event) => ({ type: 'STATUS_CHANGED', ...event })),
    ...messages.map((event) => ({ type: 'MESSAGE_CREATED', ...event })),
    ...payments.map((event) => ({ type: 'PAYMENT_UPDATED', ...event })),
  ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 50)
  return res.json({ events })
})

router.get('/bookings', async (req, res) => {
  const page = numberQuery(req.query.page, 1, 100000)
  const pageSize = numberQuery(req.query.pageSize, 25, 100)
  if (!page || !pageSize) return res.status(400).json({ message: 'page and pageSize must be positive integers' })
  const { status, search, type } = req.query
  const where = {
    ...(status && bookingStatuses.includes(status) ? { status } : {}),
    ...(type && ['HOURLY', 'DAILY', 'EVENT', 'OUTSTATION'].includes(type) ? { bookingType: type } : {}),
    ...(search ? { OR: [{ bookingNumber: { contains: search, mode: 'insensitive' } }, { user: { name: { contains: search, mode: 'insensitive' } } }] } : {}),
  }
  if ((status && !bookingStatuses.includes(status)) || (type && !['HOURLY', 'DAILY', 'EVENT', 'OUTSTATION'].includes(type))) {
    return res.status(400).json({ message: 'Invalid booking status or type' })
  }
  const [bookings, total] = await Promise.all([
    prisma.booking.findMany({ where, skip: (page - 1) * pageSize, take: pageSize, include: bookingInclude(), orderBy: { createdAt: 'desc' } }),
    prisma.booking.count({ where }),
  ])
  return res.json({ bookings, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } })
})

router.get('/bookings/calendar', async (req, res) => {
  const { from, to, status, vehicleId } = req.query
  const fromDate = from ? new Date(from) : new Date()
  const toDate = to ? new Date(to) : new Date(fromDate.getTime() + 30 * 24 * 60 * 60 * 1000)

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate > toDate) {
    return res.status(400).json({ message: 'from and to must be valid dates, and from must be before to' })
  }
  if (status && !bookingStatuses.includes(status)) {
    return res.status(400).json({ message: 'Invalid booking status' })
  }

  const bookings = await prisma.booking.findMany({
    where: {
      startDate: { lte: toDate },
      endDate: { gte: fromDate },
      ...(status && { status }),
      ...(vehicleId && { vehicleId }),
    },
    include: {
      user: { select: { id: true, name: true, phone: true } },
      vehicle: { select: { id: true, brand: true, name: true, registrationNumber: true } },
      driver: { select: { id: true, name: true, phone: true } },
    },
    orderBy: { startDate: 'asc' },
  })

  const events = bookings.map((booking) => ({
    id: booking.id,
    bookingNumber: booking.bookingNumber,
    title: `${booking.vehicle.name} - ${booking.user.name}`,
    start: booking.startDate,
    end: booking.endDate,
    startTime: booking.startTime,
    endTime: booking.endTime,
    status: booking.status,
    bookingType: booking.bookingType,
    user: booking.user,
    vehicle: booking.vehicle,
    driver: booking.driver,
  }))

  return res.json({ from: fromDate, to: toDate, events })
})

router.get('/bookings/:id', async (req, res) => {
  const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, include: bookingInclude() })
  if (!booking) return res.status(404).json({ message: 'Booking not found' })
  return res.json({ booking })
})

router.patch('/bookings/:id/status', async (req, res) => {
  const { status, reason, changedByType = req.user.role } = req.body
  if (!bookingStatuses.includes(status) || !changedByTypes.includes(changedByType)) {
    return res.status(400).json({ message: 'Valid status and changedByType are required' })
  }
  const pricing = status === 'CONFIRMED' ? parseBookingPricing(req.body) : null
  if (status === 'CONFIRMED' && !pricing) {
    return res.status(400).json({
      message: 'A positive vehicleRental and valid non-negative charges, taxes, discount, and advanceAmount are required to confirm a booking',
    })
  }
  const booking = await prisma.$transaction(async (transaction) => {
    const current = await transaction.booking.findUnique({ where: { id: req.params.id } })
    if (!current) { const error = new Error('Booking not found'); error.statusCode = 404; throw error }
    const updated = await transaction.booking.update({ where: { id: current.id }, data: { status, ...(pricing || {}) }, include: bookingInclude() })
    await transaction.bookingStatusHistory.create({ data: { bookingId: current.id, fromStatus: current.status, toStatus: status, changedByType, changedById: req.user.id, reason } })
    return updated
  })
  return res.json({ booking })
})

router.post('/bookings/:id/assign-driver', async (req, res) => {
  const { driverId, notifyCustomer = false } = req.body
  const driver = await prisma.driver.findUnique({ where: { id: driverId } })
  if (!driver || !driver.active) return res.status(404).json({ message: 'Active driver not found' })
  const booking = await prisma.$transaction(async (transaction) => {
    const current = await transaction.booking.findUnique({ where: { id: req.params.id } })
    if (!current) { const error = new Error('Booking not found'); error.statusCode = 404; throw error }
    const updated = await transaction.booking.update({ where: { id: current.id }, data: { driverId, status: 'DRIVER_ASSIGNED' }, include: bookingInclude() })
    await transaction.bookingStatusHistory.create({ data: { bookingId: current.id, fromStatus: current.status, toStatus: 'DRIVER_ASSIGNED', changedByType: req.user.role, changedById: req.user.id, reason: 'Driver assigned' } })
    if (notifyCustomer) await transaction.bookingMessage.create({ data: { bookingId: current.id, senderType: 'STAFF', senderUserId: req.user.id, body: `Driver ${driver.name} has been assigned.` } })
    return updated
  })
  return res.json({ booking, notified: notifyCustomer })
})

router.post('/bookings/:id/cancel', async (req, res) => {
  const { reason, issueRefund = false, deductionAmount = 0 } = req.body
  if (!reason || typeof deductionAmount !== 'number' || deductionAmount < 0) return res.status(400).json({ message: 'reason and a non-negative deductionAmount are required' })
  const booking = await prisma.$transaction(async (transaction) => {
    const current = await transaction.booking.findUnique({ where: { id: req.params.id }, include: { payments: { where: { status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' }, take: 1 } } })
    if (!current) { const error = new Error('Booking not found'); error.statusCode = 404; throw error }
    const updated = await transaction.booking.update({ where: { id: current.id }, data: { status: issueRefund ? 'REFUND_PENDING' : 'CANCELLED', cancellationReason: reason, cancelledAt: new Date() }, include: bookingInclude() })
    await transaction.bookingStatusHistory.create({ data: { bookingId: current.id, fromStatus: current.status, toStatus: updated.status, changedByType: req.user.role, changedById: req.user.id, reason } })
    if (issueRefund && current.payments[0]) {
      await transaction.refund.upsert({
        where: { bookingId: current.id },
        create: { bookingId: current.id, paymentId: current.payments[0].id, amount: Math.max(0, current.payments[0].amount - deductionAmount), reason },
        update: { amount: Math.max(0, current.payments[0].amount - deductionAmount), reason, status: 'PENDING' },
      })
    }
    return updated
  })
  return res.json({ booking })
})

router.get('/vehicles', async (req, res) => {
  const { category, available } = req.query
  if (category && !categories.includes(category)) return res.status(400).json({ message: 'Invalid vehicle category' })
  if (available !== undefined && !['true', 'false'].includes(available)) return res.status(400).json({ message: 'available must be true or false' })
  const vehicles = await prisma.vehicle.findMany({ where: { ...(category && { category }), ...(available !== undefined && { available: available === 'true' }) }, include: { images: true, features: true, pickupHub: true }, orderBy: { createdAt: 'desc' } })
  return res.json({ vehicles })
})

router.post('/vehicles', async (req, res) => {
  const { images = [], featureTags = [], ...vehicleData } = req.body
  const vehicle = await prisma.vehicle.create({ data: { ...vehicleData, images: { create: images.map((url, sortOrder) => ({ url, sortOrder, isPrimary: sortOrder === 0 })) }, features: { create: featureTags.map((name) => ({ name })) } }, include: { images: true, features: true, pickupHub: true } })
  return res.status(201).json({ vehicle })
})

router.put('/vehicles/:id', async (req, res) => {
  const { images, featureTags, ...vehicleData } = req.body
  const vehicle = await prisma.$transaction(async (transaction) => {
    if (images) await transaction.vehicleImage.deleteMany({ where: { vehicleId: req.params.id } })
    if (featureTags) await transaction.vehicleFeature.deleteMany({ where: { vehicleId: req.params.id } })
    return transaction.vehicle.update({ where: { id: req.params.id }, data: { ...vehicleData, ...(images && { images: { create: images.map((url, sortOrder) => ({ url, sortOrder, isPrimary: sortOrder === 0 })) } }), ...(featureTags && { features: { create: featureTags.map((name) => ({ name })) } }) }, include: { images: true, features: true, pickupHub: true } })
  })
  return res.json({ vehicle })
})

router.delete('/vehicles/:id', async (req, res) => {
  const vehicle = await prisma.vehicle.update({ where: { id: req.params.id }, data: { available: false } })
  return res.json({ vehicle, message: 'Vehicle archived' })
})

router.post('/vehicles/:id/availability-block', async (req, res) => {
  const { startAt, endAt, reason } = req.body
  const start = new Date(startAt)
  const end = new Date(endAt)
  if (!startAt || !endAt || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) return res.status(400).json({ message: 'Valid startAt and endAt are required' })
  const vehicle = await prisma.vehicle.findUnique({ where: { id: req.params.id }, select: { id: true } })
  if (!vehicle) return res.status(404).json({ message: 'Vehicle not found' })
  const existingBlock = await prisma.vehicleAvailability.findFirst({
    where: { vehicleId: req.params.id, startAt: { lt: end }, endAt: { gt: start } },
  })
  if (existingBlock) return res.status(409).json({ message: 'This availability block overlaps an existing block' })
  const block = await prisma.vehicleAvailability.create({ data: { vehicleId: req.params.id, startAt: start, endAt: end, reason } })
  return res.status(201).json({ availabilityBlock: block })
})

router.get('/hubs', async (_req, res) => res.json({ hubs: await prisma.pickupHub.findMany({ include: { vehicles: true }, orderBy: { createdAt: 'desc' } }) }))

router.post('/hubs', async (req, res) => {
  const { name, address, city, state, postalCode, latitude, longitude } = req.body
  if (!name || !address || !city) return res.status(400).json({ message: 'name, address and city are required' })
  const hub = await prisma.pickupHub.create({ data: { name, address, city, state, postalCode, latitude, longitude } })
  return res.status(201).json({ hub })
})

router.get('/drivers', async (req, res) => {
  const { status } = req.query
  if (status && !driverStatuses.includes(status)) return res.status(400).json({ message: 'Invalid driver status' })
  return res.json({ drivers: await prisma.driver.findMany({ where: status ? { status } : {}, orderBy: { createdAt: 'desc' } }) })
})

router.post('/drivers', async (req, res) => {
  const { name, phone, licenseNumber, vehicle, vehicleNumber, status = 'AVAILABLE' } = req.body
  if (!name || !phone || !licenseNumber || !driverStatuses.includes(status)) return res.status(400).json({ message: 'name, phone, licenseNumber and valid status are required' })
  const driver = await prisma.driver.create({ data: { name, phone, licenseNumber, vehicle, vehicleNumber, status, initials: name.split(/\s+/).map((part) => part[0]).join('').slice(0, 3).toUpperCase() } })
  return res.status(201).json({ driver })
})

router.get('/drivers/locations', async (_req, res) => {
  const locations = await prisma.driverLocation.findMany({ distinct: ['driverId'], orderBy: { createdAt: 'desc' }, include: { driver: true } })
  return res.json({ locations })
})

export default router

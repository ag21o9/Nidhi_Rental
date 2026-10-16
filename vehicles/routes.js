import { Router } from 'express'
import { prisma } from '../database/client.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'

const router = Router()

const allowedCategories = ['SEDAN', 'SUV', 'LUXURY', 'MUV', 'HATCHBACK', 'TEMPO_TRAVELLER', 'BUS']
const allowedTransmissions = ['AUTOMATIC', 'MANUAL']
const allowedFuelTypes = ['PETROL', 'DIESEL', 'ELECTRIC', 'HYBRID']

router.get('/', async (req, res) => {
  const {
    name,
    category,
    seats,
    minSeats,
    maxSeats,
    doors,
    transmission,
    fuelType,
    ac,
    luggage,
    minLuggage,
    maxLuggage,
    hourlyPrice,
    maxHourlyPrice,
    dailyPrice,
    maxDailyPrice,
    available,
  } = req.query

  const numericFilters = {
    seats,
    minSeats,
    maxSeats,
    doors,
    luggage,
    minLuggage,
    maxLuggage,
    hourlyPrice,
    maxHourlyPrice,
    dailyPrice,
    maxDailyPrice,
  }
  const parsedNumbers = Object.fromEntries(
    Object.entries(numericFilters).map(([key, value]) => [key, value === undefined ? undefined : Number(value)]),
  )

  if (Object.values(parsedNumbers).some((value) => value !== undefined && !Number.isInteger(value))) {
    return res.status(400).json({ message: 'Numeric vehicle filters must be whole numbers' })
  }
  if (category && !allowedCategories.includes(category)) {
    return res.status(400).json({ message: 'Invalid vehicle category' })
  }
  if (transmission && !allowedTransmissions.includes(transmission)) {
    return res.status(400).json({ message: 'Invalid transmission' })
  }
  if (fuelType && !allowedFuelTypes.includes(fuelType)) {
    return res.status(400).json({ message: 'Invalid fuel type' })
  }
  if (ac !== undefined && !['true', 'false'].includes(ac)) {
    return res.status(400).json({ message: 'ac must be true or false' })
  }
  if (available !== undefined && !['true', 'false'].includes(available)) {
    return res.status(400).json({ message: 'available must be true or false' })
  }

  const where = {
    available: available === undefined ? true : available === 'true',
    ...(name && { name: { contains: name, mode: 'insensitive' } }),
    ...(category && { category }),
    ...(transmission && { transmission }),
    ...(fuelType && { fuelType }),
    ...(ac !== undefined && { ac: ac === 'true' }),
    ...(seats !== undefined && { seats: parsedNumbers.seats }),
    ...(doors !== undefined && { doors: parsedNumbers.doors }),
    ...(luggage !== undefined && { luggage: parsedNumbers.luggage }),
    ...(hourlyPrice !== undefined && { hourlyPrice: parsedNumbers.hourlyPrice }),
    ...(dailyPrice !== undefined && { dailyPrice: parsedNumbers.dailyPrice }),
    ...((minSeats !== undefined || maxSeats !== undefined) && {
      seats: { gte: parsedNumbers.minSeats, lte: parsedNumbers.maxSeats },
    }),
    ...((minLuggage !== undefined || maxLuggage !== undefined) && {
      luggage: { gte: parsedNumbers.minLuggage, lte: parsedNumbers.maxLuggage },
    }),
    ...((maxHourlyPrice !== undefined) && {
      hourlyPrice: { lte: parsedNumbers.maxHourlyPrice },
    }),
    ...((maxDailyPrice !== undefined) && {
      dailyPrice: { lte: parsedNumbers.maxDailyPrice },
    }),
  }

  const vehicles = await prisma.vehicle.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  })
  return res.json({ vehicles })
})

router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const {
    brand, name, model, registrationNumber, category, seats, doors,
    transmission, fuelType, ac, luggage, description,
    hourlyPrice, dailyPrice, eventPrice, outstationPrice,
  } = req.body

  if (!brand || !name || !model || !registrationNumber || !category || !seats || !transmission || !fuelType) {
    return res.status(400).json({ message: 'brand, name, model, registrationNumber, category, seats, transmission and fuelType are required' })
  }
  if (!allowedCategories.includes(category) || !allowedTransmissions.includes(transmission) || !allowedFuelTypes.includes(fuelType)) {
    return res.status(400).json({ message: 'Invalid vehicle category, transmission or fuel type' })
  }

  const vehicle = await prisma.vehicle.create({
    data: {
      brand, name, model, registrationNumber, category, seats, doors,
      transmission, fuelType, ac: ac ?? true, luggage, description,
      hourlyPrice, dailyPrice, eventPrice, outstationPrice,
    },
  })

  return res.status(201).json({ vehicle })
})

router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  const vehicle = await prisma.vehicle.update({
    where: { id: req.params.id },
    data: req.body,
  })
  return res.json({ vehicle })
})

export default router

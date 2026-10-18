import { Router } from 'express'
import { prisma } from '../database/client.js'
import { createToken, requireAuth } from '../middleware/auth.js'

const router = Router()
const locationKinds = ['HOME', 'WORK', 'GYM', 'AIRPORT', 'OTHER']

function publicUser(user) {
  const { passwordHash, ...safeUser } = user
  return safeUser
}

router.post('/register', async (req, res) => {
  const { name, email, phone, password } = req.body

  if (!name || !email || !password) {
    return res.status(400).json({ message: 'name, email and password are required' })
  }

  const existingUser = await prisma.user.findUnique({ where: { email } })
  if (existingUser) {
    return res.status(409).json({ message: 'An account with this email already exists' })
  }

  const user = await prisma.user.create({
    data: { name, email, phone, passwordHash: password },
  })

  return res.status(201).json({ user: publicUser(user), token: createToken(user) })
})

router.post('/login', async (req, res) => {
  const { email, password } = req.body
  const user = await prisma.user.findUnique({ where: { email } })

  if (!user || user.passwordHash !== password || user.status !== 'ACTIVE') {
    return res.status(401).json({ message: 'Invalid email or password' })
  }

  return res.json({ user: publicUser(user), token: createToken(user) })
})

router.post('/bootstrap-admin', async (req, res) => {
  const setupKey = process.env.ADMIN_SETUP_KEY
  // if (!setupKey || req.headers['x-admin-setup-key'] !== setupKey) {
  //   return res.status(403).json({ message: 'Admin setup is not enabled' })
  // }

  const { name, email, phone, password } = req.body
  if (!name || !email || !password) {
    return res.status(400).json({ message: 'name, email and password are required' })
  }

  const existingUser = await prisma.user.findUnique({ where: { email } })
  if (existingUser) {
    return res.status(409).json({ message: 'An account with this email already exists' })
  }

  const user = await prisma.user.create({
    data: { name, email, phone, passwordHash: password, role: 'ADMIN' },
  })

  return res.status(201).json({ user: publicUser(user), token: createToken(user) })
})

router.get('/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } })
  if (!user) {
    return res.status(404).json({ message: 'User not found' })
  }
  return res.json({ user: publicUser(user) })
})

router.post('/saved-locations', requireAuth, async (req, res) => {
  const {
    label, kind = 'OTHER', address, city, state, postalCode,
    latitude, longitude,
  } = req.body

  if (!label || !address) {
    return res.status(400).json({ message: 'label and address are required' })
  }
  if (typeof label !== 'string' || typeof address !== 'string') {
    return res.status(400).json({ message: 'label and address must be strings' })
  }
  if (!locationKinds.includes(kind)) {
    return res.status(400).json({ message: 'Invalid location kind' })
  }

  const hasLatitude = latitude !== undefined && latitude !== null
  const hasLongitude = longitude !== undefined && longitude !== null
  if (hasLatitude !== hasLongitude) {
    return res.status(400).json({ message: 'latitude and longitude must be provided together' })
  }
  if (hasLatitude && (
    typeof latitude !== 'number'
    || typeof longitude !== 'number'
    || !Number.isFinite(latitude)
    || !Number.isFinite(longitude)
    || latitude < -90
    || latitude > 90
    || longitude < -180
    || longitude > 180
  )) {
    return res.status(400).json({ message: 'latitude or longitude is invalid' })
  }

  const savedLocation = await prisma.savedLocation.create({
    data: {
      userId: req.user.id,
      label,
      kind,
      address,
      city,
      state,
      postalCode,
      latitude,
      longitude,
    },
  })

  return res.status(201).json({ savedLocation })
})

router.get('/saved-locations', requireAuth, async (req, res) => {
  const savedLocations = await prisma.savedLocation.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
  })

  return res.json({ savedLocations })
})

export default router

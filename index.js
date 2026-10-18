import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { prisma } from './database/client.js'
import userRoutes from './users/routes.js'
import vehicleRoutes from './vehicles/routes.js'
import bookingRoutes from './bookings/routes.js'
import adminRoutes from './admin/routes.js'

const app = express()
const port = Number(process.env.PORT || 3000)

app.use(cors())
app.use(express.json())

app.get('/health', (_req, res) => res.json({ status: 'ok' }))
app.use('/api/auth', userRoutes)
app.use('/api/vehicles', vehicleRoutes)
app.use('/api/bookings', bookingRoutes)
app.use('/api/admin', adminRoutes)

app.use((error, _req, res, _next) => {
  console.error(error)
  res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : 'Internal server error' })
})

const server = app.listen(port, () => {
  console.log(`NidhiRental API running on http://localhost:${port}`)
})

async function shutdown() {
  await prisma.$disconnect()
  server.close()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

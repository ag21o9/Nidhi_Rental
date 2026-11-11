export function parseBookingPricing(input = {}) {
  const {
    vehicleRental,
    driverCharges = 0,
    taxes = 0,
    discount = 0,
    advanceAmount = 0,
  } = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const maxAmount = 2147483647

  if (
    !Number.isSafeInteger(vehicleRental)
    || vehicleRental <= 0
    || vehicleRental > maxAmount
    || ![driverCharges, taxes, discount, advanceAmount].every(
      (amount) => Number.isSafeInteger(amount) && amount >= 0 && amount <= maxAmount,
    )
  ) {
    return null
  }

  const subtotal = vehicleRental + driverCharges + taxes
  const totalAmount = subtotal - discount
  if (subtotal > maxAmount || totalAmount <= 0 || advanceAmount > totalAmount) {
    return null
  }

  return {
    vehicleRental,
    driverCharges,
    taxes,
    discount,
    totalAmount,
    advanceAmount,
    remainingAmount: totalAmount - advanceAmount,
  }
}
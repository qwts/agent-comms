// Fixed production seam: no caller path, key selector, compiler, fixture, or
// arbitrary signing callback. Native protected source/signing is not installed.
export function createProtectedOwnerReceiptCapability() {
  throw new Error('owner-receipt-unavailable');
}

const PRODUCT_TOUR_KEY = 'cairn.product-tour.v1'

export function hasCompletedProductTour(): boolean {
  try {
    return window.localStorage.getItem(PRODUCT_TOUR_KEY) === 'complete'
  } catch {
    return false
  }
}

export function saveProductTourCompletion(): void {
  try {
    window.localStorage.setItem(PRODUCT_TOUR_KEY, 'complete')
  } catch {
    // Completion remains session-only if storage is unavailable.
  }
}

/**
 * MDSG Pricing Calculator
 * Built from the MDSG_MASTER_COST_WORKSHEET logic
 */

const DEFAULTS = {
  dealer_discount_pct: 0.05,      // 5% dealer discount from list
  markup_multiplier: 1.34,         // standard cabinet markup (yields ~25% margin)
  hardware_margin: 1.40,           // hardware markup
  sales_tax_rate: 0.0915,          // Colorado sales tax
}

/**
 * Calculate full pricing from a manufacturer quote
 * 
 * @param {object} params
 * @param {number} params.manufacturer_gross - Leedo/Skyline/SMART list price
 * @param {number} params.freight - freight cost
 * @param {number} params.hardware_cost - hardware cost at dealer cost
 * @param {number} params.plywood_upgrade - per-cabinet plywood upgrade cost (optional)
 * @param {number} params.cabinet_count - total cabinet count for plywood upgrade calc
 * @param {number} params.markup_multiplier - override default 1.34x (optional)
 * @param {number} params.dealer_discount_pct - override default 5% (optional)
 */
export function calculatePricing(params) {
  const {
    manufacturer_gross = 0,
    freight = 0,
    hardware_cost = 0,
    plywood_upgrade = 0,
    cabinet_count = 0,
    markup_multiplier = DEFAULTS.markup_multiplier,
    dealer_discount_pct = DEFAULTS.dealer_discount_pct,
  } = params

  // Step 1: Apply dealer discount to manufacturer gross
  const discount_amount = manufacturer_gross * dealer_discount_pct
  const discounted_cabinet_cost = manufacturer_gross - discount_amount

  // Step 2: Add freight (not discounted)
  const total_cost_before_markup = discounted_cabinet_cost + freight

  // Step 3: Apply MDSG markup
  const cabinets_to_gc = total_cost_before_markup * markup_multiplier

  // Step 4: Plywood upgrade (if applicable)
  const plywood_upgrade_total = plywood_upgrade * cabinet_count
  const plywood_upgrade_to_gc = plywood_upgrade_total > 0
    ? plywood_upgrade_total * markup_multiplier
    : 0

  // Step 5: Hardware with its own margin
  const hardware_to_gc = hardware_cost * DEFAULTS.hardware_margin

  // Step 6: Grand total bid to GC
  const total_bid = cabinets_to_gc + plywood_upgrade_to_gc + hardware_to_gc

  // Step 7: Calculate actual margin
  const total_cost = total_cost_before_markup + plywood_upgrade_total + hardware_cost
  const gross_profit = total_bid - total_cost
  const gross_margin_pct = total_bid > 0 ? gross_profit / total_bid : 0

  return {
    // Costs
    manufacturer_gross,
    discount_amount: round(discount_amount),
    discounted_cabinet_cost: round(discounted_cabinet_cost),
    freight,
    total_cost_before_markup: round(total_cost_before_markup),
    hardware_cost,
    plywood_upgrade_total: round(plywood_upgrade_total),
    total_cost: round(total_cost),

    // To GC
    cabinets_to_gc: round(cabinets_to_gc),
    plywood_upgrade_to_gc: round(plywood_upgrade_to_gc),
    hardware_to_gc: round(hardware_to_gc),
    total_bid: round(total_bid),

    // Margin analysis
    gross_profit: round(gross_profit),
    gross_margin_pct: round(gross_margin_pct, 4),
    gross_margin_display: `${(gross_margin_pct * 100).toFixed(1)}%`,

    // Multipliers used
    markup_multiplier,
    dealer_discount_pct,
  }
}

/**
 * Quick margin check — given a target margin, what markup multiplier do you need?
 * Useful for GC budget pushback situations
 */
export function markupForTargetMargin(targetMarginPct) {
  // margin = (price - cost) / price
  // price = cost / (1 - margin)
  // multiplier = 1 / (1 - margin)
  return round(1 / (1 - targetMarginPct), 4)
}

/**
 * What margin does a given multiplier yield?
 */
export function marginFromMultiplier(multiplier) {
  return round(1 - (1 / multiplier), 4)
}

/**
 * Margin reference table — useful for proposal negotiations
 * Returns array of {multiplier, margin} pairs
 */
export function marginTable() {
  return [
    { multiplier: 1.20, margin: '16.7%', label: 'Minimum (emergency)' },
    { multiplier: 1.25, margin: '20.0%', label: 'Floor (target minimum)' },
    { multiplier: 1.30, margin: '23.1%', label: 'Standard low' },
    { multiplier: 1.34, margin: '25.4%', label: 'MDSG standard' },
    { multiplier: 1.40, margin: '28.6%', label: 'Target' },
    { multiplier: 1.50, margin: '33.3%', label: 'Strong' },
    { multiplier: 1.60, margin: '37.5%', label: 'Premium' },
  ]
}

function round(num, decimals = 2) {
  return Math.round(num * Math.pow(10, decimals)) / Math.pow(10, decimals)
}

// ── lib/skuRules.js ──────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for SKU classification patterns.
// Every consumer (Excel parser, PDF takeoff, TakeoffEngine, AgentPipeline,
// hardwareUtils, exports) imports from here. Fix a pattern once, it's fixed
// everywhere.

// Appliances — excluded from cabinet counts entirely.
// CRITICAL: DW(?!\d{4}) — "DW" alone or DW24 is a dishwasher space, but
// DW2436-style (DW + 4 digits) is a Diagonal Wall CABINET and must count.
export const APPLIANCE_RE = /^(DISH|DW(?!\d{4})|DISW|RANGE|REF[LR0-9]?|MICRO|OTR|APPLI|WASH|DRYER|OVEN|HOOD|VENT)/i

// Fillers, panels, misc — tracked separately, never counted as cabinets.
// SMC = common typo of SCM (scribe). REP/TREP/VEP/TEP = end panel family.
export const FILLER_RE = /^(WF|TF|BF|F\d|FS\d|TK\d*|SCM|SMC|OCM|BEP|REP|TREP|VEP|TEP|DWEP|EPT|PLYS|BRP|TRP|STVAL)/i  // FS=skins, BRP/TRP=return panels, STVAL=valance

// Category/section labels on cabinet list sheets.
export const CATEGORY_LABELS = /^(BASES?|VANIT(?:Y|IES)|WALLS?|TALLS?|ACCESSORIES|MISC(?:ELLANEOUS)?|FILLERS?|TRIM|MOLDING|HARDWARE\s*ALLOWANCES?)S?$/i

export function isApplianceSku(sku) {
  return APPLIANCE_RE.test(String(sku || '').trim())
}

export function isFillerSku(sku) {
  return FILLER_RE.test(String(sku || '').trim())
}

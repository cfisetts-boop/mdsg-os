/**
 * MDSG Hardware Count Utility
 * Based on Cabinet Schedule Reference Guide v2 (April 2026)
 * Rules: Blake's reference guide — Leedo LDOF0925_6 / LDOE0925_5, 20-20 SKYL_SS_2
 */

// ── Special-case SKUs confirmed from catalog PDFs ─────────────────────────────
const SPECIAL_CASES = {
  'CVDB36BDHL':      5,  // Corner vanity drawer base — Leedo LDOF0925_6
  'BLS36R':          1,  // Base Lazy Susan — Leedo LDOF0925_6
  'CW2436R':         1,  // Corner Wall — Leedo LDOF0925_6
  'B30FH':           2,  // Base FH suffix — Leedo LDOE0925_5
  'CVSDB36HFHR':     2,  // Corner Vanity Sink/Drawer Base — Leedo LDOE0925_5
  'EPT90':           0,  // Tall End Panel — Leedo LDOE0925_5
  'CVSDB48-DB15L':   6,  // Corner Vanity specialty (4 drawers + 2 doors) — Leedo LDOF0925_6
}

// ── Zero-hardware SKU patterns ────────────────────────────────────────────────
const ZERO_HARDWARE_PREFIXES = ['F3', 'F4', 'F5', 'F6', 'TRP', 'BRP', 'TKPW', 'TKC', 'OCM', 'WF', 'TF', 'BEP', 'EPB', 'TK8', 'TSK', 'SCM']
const ZERO_HARDWARE_EXACT    = ['PLYS', 'EPT', 'AD21', 'OCM']

function isZeroHardware(sku) {
  const upper = sku.toUpperCase()
  if (ZERO_HARDWARE_EXACT.some(p => upper === p || upper.startsWith(p))) return true
  if (ZERO_HARDWARE_PREFIXES.some(p => upper.startsWith(p))) return true
  return false
}

// ── Width extraction ──────────────────────────────────────────────────────────
// Cabinet SKUs encode dimensions as concatenated 2-digit pairs: W1236 = 12w 36h
// Must split on 2-digit boundaries — do NOT match 3-digit runs (W1236 width = 12, not 123).
const VALID_WIDTHS = new Set([9,12,15,18,21,24,27,30,33,36,39,42,45,48])

function extractWidth(sku) {
  // Strip accessible height suffix before parsing
  const sku32 = sku.replace(/-32\.5$/, '').replace(/-32\.5-/, '-')
  // Remove SKYL leading numeric prefix (e.g. 3DB15 → DB15)
  const stripped = sku32.replace(/^\d+/, '')
  // Strip prefix letters to isolate the numeric dimension string
  const numPart = stripped.replace(/^[A-Z]+/i, '')
  if (!numPart) return null

  // Try 2-digit first (covers all standard cabinet widths)
  if (numPart.length >= 2 && /^\d{2}/.test(numPart)) {
    const two = parseInt(numPart.substring(0, 2), 10)
    if (VALID_WIDTHS.has(two)) return two
  }
  // Fall back to 3-digit (unusual but possible)
  if (numPart.length >= 3 && /^\d{3}/.test(numPart)) {
    return parseInt(numPart.substring(0, 3), 10)
  }
  return null
}

// ── Section classification ────────────────────────────────────────────────────
// Appliance SKU patterns — never count toward cabinets or hardware
export function isAppliance(sku) {
  const u = (sku || '').toUpperCase().trim()
  return /^(DISH|DW|DISW|RANGE|REF[LR0-9]?|MICRO|OTR|APPLI|WASH|DRYER|OVEN|HOOD|VENT)/.test(u)
}

export function getSection(sku) {
  const u = sku.toUpperCase()
  if (isAppliance(u))                                     return 'Appliance'
  // ── Toe Kick ──
  if (/^(TKPW|TKC|TK8|TSK)/.test(u))                    return 'Toe Kick'
  // ── End Panel ──
  if (/^(PLYS|EPT|AD21)/.test(u))                        return 'End Panel'
  // ── Scribe molding (SCM75 etc) ──
  if (/^SCM/.test(u))                                    return 'Scribe'
  // ── Filler / OCM ──
  if (/SCRIBE|SCRI/.test(u))                             return 'Filler'
  if (/SKIN|SHELF/.test(u))                              return 'Filler'
  if (/^(BF|TF|WF|BEP)/.test(u))                         return 'Filler'
  if (/^EPB/.test(u))                                    return 'End Panel'
  if (/^(F\d|TRP|BRP|OCM)/.test(u))                     return 'Filler'
  // ── Corner Vanity Base ──
  if (/^(CVSDB|CVDB)/.test(u))                           return 'Corner Vanity Base'
  // ── Vanity Base - Sink ──
  if (/^(VSB|VSD)/.test(u))                              return 'Vanity Base - Sink'
  // ── Vanity Base ──
  if (/^(VDB|VB)/.test(u))                               return 'Vanity Base'
  // ── Base - Drawer ──
  if (/^DB/.test(u))                                     return 'Base - Drawer'
  if (/^\d+(DB|DWR)/.test(u))                            return 'Base - Drawer'
  if (/^DWR/.test(u))                                    return 'Base - Drawer'
  // ── Base - Sink ──
  if (/^SB/.test(u))                                     return 'Base - Sink'
  // ── Base (Handicap / Accessible) — HC, HCA, HCSB, EB all stay in Base per ref guide ──
  if (/^(HC|HCA|EB)/.test(u))                            return 'Base'
  // ── Base ──
  if (/^(BB|BLS|BMC)/.test(u))                           return 'Base'
  if (/^B/.test(u))                                      return 'Base'
  // ── Wall ──
  if (/^(BW|CW|WBC|WHL|WO)/.test(u))                    return 'Wall'
  if (/^W/.test(u))                                      return 'Wall'
  // ── Tall Cabinet ──
  if (/^(LC|LT|PT)/.test(u))                             return 'Tall Cabinet'
  if (/^(T\d|P\d)/.test(u))                              return 'Tall Cabinet'
  // ── SKYL numeric prefix ──
  if (/^\d+VDB/.test(u))                                 return 'Vanity Base'
  if (/^VS/.test(u))                                     return 'Vanity Base - Sink'
  return 'Base'
}

// Section display order for sorting
const SECTION_ORDER = [
  'Base - Drawer',
  'Base - Sink',
  'Base',
  'Corner Vanity Base',
  'Vanity Base',
  'Vanity Base - Sink',
  'Wall',
  'Tall Cabinet',
  'Filler',
  'Scribe',
  'Toe Kick',
  'End Panel',
]
export function sectionSortIndex(section) {
  const i = SECTION_ORDER.indexOf(section)
  return i === -1 ? 99 : i
}

// ── Main hardware calculation ─────────────────────────────────────────────────
/**
 * Returns { hardware: number, specialCase: boolean, note: string|null }
 */
export function calculateHardware(sku) {
  const upper = sku.toUpperCase().trim()

  // 1. Zero-hardware items
  if (isZeroHardware(upper)) {
    return { hardware: 0, specialCase: false, note: null }
  }

  // Strip -32.5 accessible height suffix before ALL pattern matching
  const upperBase = upper.replace(/-32\.5$/,'').replace(/-32\.5-/,'-')

  // 2. Special cases — confirmed from catalog PDFs (ref guide §5)
  if (SPECIAL_CASES[upperBase] !== undefined) {
    return {
      hardware: SPECIAL_CASES[upperBase],   // use upperBase, not upper — fixes -32.5 suffix mismatch
      specialCase: true,
      note: 'Special case — confirmed from catalog PDF',
    }
  }

  // 3. SKYL / 20-20 Tech numeric prefix: 3DB15 = 3 drawers, 3VDB12 = 3 (ref guide §6)
  const skylNumeric = upperBase.match(/^(\d+)(DB|VDB|DWR)/)
  if (skylNumeric) {
    return { hardware: parseInt(skylNumeric[1], 10), specialCase: false, note: 'SKYL: numeric prefix = drawer count' }
  }

  // 4. Dash-number suffix = drawer/door count (ref guide §4)
  //    DB15-3 = 3, VDB12-3 = 3. Max plausible = 6 (CVSDB48 special case = 6).
  const dashMatch = upperBase.match(/-(\d+)[A-Z]?$/)
  if (dashMatch) {
    const count = parseInt(dashMatch[1], 10)
    if (count >= 1 && count <= 6) {
      return { hardware: count, specialCase: false, note: `Dash-number suffix: -${count}` }
    }
  }

  // 5. Fixed-count categories — reference guide §4 + §11
  // Blind Base: 1 (stays in Base section)
  if (/^BB/.test(upperBase))  return { hardware: 1, specialCase: false, note: 'Blind Base — always 1 (ref guide §11)' }
  // Blind Wall: 1 (stays in Wall section)
  if (/^BW/.test(upperBase))  return { hardware: 1, specialCase: false, note: 'Blind Wall — always 1 (ref guide §11)' }
  // Handicap Accessible — HC, HCA, HCSB all = 2 (ref guide §4 + §11)
  if (/^HC/.test(upperBase))  return { hardware: 2, specialCase: false, note: 'Handicap Accessible (HC/HCA/HCSB) — always 2' }
  // EB = Easy (accessible) Base — same rule as HC: always 2
  if (/^EB/.test(upperBase))  return { hardware: 2, specialCase: false, note: 'Easy Accessible Base (EB) — always 2' }
  // Lazy Susan base: 1
  if (/^BLS/.test(upperBase)) return { hardware: 1, specialCase: false, note: 'Lazy Susan — always 1' }
  // Corner Wall: 1
  if (/^CW/.test(upperBase))  return { hardware: 1, specialCase: false, note: 'Corner Wall — always 1' }
  // Wall bridge / hamper: width-based
  if (/^(WBC|WHL)/.test(upperBase)) {
    const w = extractWidth(upperBase)
    return { hardware: (w || 99) <= 21 ? 1 : 2, specialCase: false, note: `Wall Bridge/Hamper ${w}" wide` }
  }
  // Wall open: width-based
  if (/^WO/.test(upperBase)) {
    const w = extractWidth(upperBase)
    return { hardware: (w || 99) <= 21 ? 1 : 2, specialCase: false, note: `Wall Open ${w}" wide` }
  }
  // Base Microwave Cabinet: 2
  if (/^BMC/.test(upperBase)) return { hardware: 2, specialCase: false, note: 'Base Microwave Cabinet — 2' }
  // Tall Linen / Tall cabinet / Pantry: 2 (ref guide §4 + §11)
  if (/^(LC|LT|PT)/.test(upperBase))  return { hardware: 2, specialCase: false, note: 'Tall Cabinet — always 2' }
  if (/^(T\d|P\d)/.test(upperBase))   return { hardware: 2, specialCase: false, note: 'Tall/Pantry Cabinet — always 2' }

  // 6. Width-based rules — reference guide §4
  const width = extractWidth(upperBase)

  // Drawer Base without dash (dash-number rule didn't fire): estimate by width
  if (/^DB/.test(upperBase)) {
    if (width === null) return { hardware: 2, specialCase: true, note: 'Drawer Base — no dash-number, width unknown — verify' }
    return { hardware: width <= 21 ? 2 : 3, specialCase: false, note: `Drawer Base ${width}" wide (no dash-number, estimated)` }
  }

  // Base / Sink Base: ≤21" = 2, >21" = 3
  if (/^(B|SB)/.test(upperBase)) {
    if (width === null) return { hardware: 2, specialCase: false, note: 'Base — width unknown, defaulted 2' }
    return { hardware: width <= 21 ? 2 : 3, specialCase: false, note: `Base/Sink Base ${width}" wide` }
  }

  // Wall: ≤21" = 1, >21" = 2
  if (/^W/.test(upperBase)) {
    if (width === null) return { hardware: 1, specialCase: false, note: 'Wall — width unknown, defaulted 1' }
    return { hardware: width <= 21 ? 1 : 2, specialCase: false, note: `Wall ${width}" wide` }
  }

  // Vanity Base (VSB, VDB, CVDB, CVSDB, VSD, VB, VS): ≤21" = 1, >21" = 2
  if (/^(VSB|VDB|CVDB|CVSDB|VSD|VB|VS)/.test(upperBase)) {
    if (width === null) return { hardware: 1, specialCase: false, note: 'Vanity — width unknown, defaulted 1' }
    return { hardware: width <= 21 ? 1 : 2, specialCase: false, note: `Vanity ${width}" wide` }
  }

  // Fallback — flag for manual review
  return {
    hardware: null,
    specialCase: true,
    note: 'Unknown SKU — manual review needed',
  }
}

// ── Dimension parsing from SKU ────────────────────────────────────────────────
/**
 * Attempts to parse width/height/depth from a SKU string.
 * Returns { width, height, depth } as display strings e.g. '30"', '34½"'
 */
export function parseDimensions(sku, section) {
  const u = sku.toUpperCase()

  // Zero-dimension items
  if (['Filler', 'Toe Kick', 'End Panel'].includes(section)) {
    // Height from filler code: F330 = 30", F342 = 42"
    if (/^F(\d{1})(\d{2})/.test(u)) {
      const m = u.match(/^F\d(\d{2})/)
      return { width: '—', height: m ? `${parseInt(m[1], 10)}"` : '—', depth: '—' }
    }
    return { width: '—', height: '—', depth: '—' }
  }

  // Cabinet SKU dimensions are always concatenated 2-digit pairs: W3030 = 30w 30h
  // Strip prefix letters and X-depth suffix, then split into 2-digit pairs
  const depthMatch = u.match(/X(\d{2})/)
  const dimStr = u.replace(/^[A-Z-]+/, '').replace(/X\d+.*$/, '').replace(/[A-Z].*$/, '')
  const pairs = []
  for (let i = 0; i + 1 < dimStr.length; i += 2) {
    const pair = dimStr.substring(i, i + 2)
    if (/^\d{2}$/.test(pair)) pairs.push(parseInt(pair, 10))
    else break
  }
  if (pairs.length === 0) return { width: '—', height: '—', depth: standardDepth(section) }

  const w = pairs[0]
  const height = pairs.length >= 2 ? `${pairs[1]}"` : standardHeight(section)
  // Depth priority: explicit X-suffix > 3rd pair (e.g. LT158421 = 15w 84h 21d) > standard
  const depth = depthMatch
    ? `${parseInt(depthMatch[1], 10)}"`
    : pairs.length >= 3 ? `${pairs[2]}"` : standardDepth(section)

  return { width: `${w}"`, height, depth }
}

function standardHeight(section) {
  if (section === 'Base' || section === 'Base - Drawer' || section === 'Base - Sink') return '34½"'
  if (section === 'Vanity Base' || section === 'Vanity Base - Sink' || section === 'Corner Vanity Base') return '31½"'
  if (section === 'Wall') return '—'
  return '—'
}

function standardDepth(section) {
  if (['Base', 'Base - Drawer', 'Base - Sink'].includes(section)) return '24"'
  if (['Vanity Base', 'Vanity Base - Sink', 'Corner Vanity Base'].includes(section)) return '21"'
  if (section === 'Wall') return '12"'
  return '—'
}

// ── Hinge normalization ───────────────────────────────────────────────────────
export function normalizeHinge(hingeRaw) {
  if (!hingeRaw) return 'Both'
  const h = hingeRaw.toUpperCase().trim()
  if (h === 'L' || h === 'LEFT') return 'Left'
  if (h === 'R' || h === 'RIGHT') return 'Right'
  if (h === 'L/R' || h === 'BOTH' || h === 'NA' || h === 'NONE') return 'Both'
  return hingeRaw
}

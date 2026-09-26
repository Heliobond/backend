# Division-by-Zero Bug Fix: scoring-formula.ts

## Issue
The `computeScoresWithFormula()` function in [src/lib/scoring-formula.ts](src/lib/scoring-formula.ts) lacked a guard against `solar.max_power_kw === 0`, leading to NaN propagation through the scoring pipeline.

### Root Cause
**Line 96 (before fix):**
```typescript
const powerComponent = (solar.power_output_kw / solar.max_power_kw) * 100 * w.power_weight;
```

When `max_power_kw = 0`:
- If `power_output_kw = 0`: results in `0 / 0 = NaN`
- `NaN` propagates through: `Math.max(0, Math.min(100, NaN))` → `NaN`
- `Math.round(NaN)` → `NaN`
- `credit_quality` becomes `NaN` instead of a finite number

### Impact
- The endpoint `GET /v1/scoring/formulas/:id/preview/:projectId` (in [src/routes/scoring-formulas.ts](src/routes/scoring-formulas.ts)) returns responses with `scores.withFormula` and `delta` fields containing `NaN`
- Unlike `computeScores()` in [src/lib/scoring.ts](src/lib/scoring.ts), `computeScoresWithFormula()` had no `isNaN` check before serialization
- Real-world scenario: idle/misconfigured solar panels with `power_output_kw = 0` and `max_power_kw = 0`

## Solution
Added a zero-guard identical to the one used in [src/lib/scoring.ts](src/lib/scoring.ts#L79):

**Lines 96-97 (after fix):**
```typescript
const powerRatio = solar.max_power_kw > 0 ? solar.power_output_kw / solar.max_power_kw : 0;
const powerComponent = powerRatio * 100 * w.power_weight;
```

This ensures:
- Division by zero is prevented
- When `max_power_kw = 0`, the power ratio defaults to `0` (no power contribution to score)
- All downstream calculations remain finite and well-defined

## Files Modified
1. **[src/lib/scoring-formula.ts](src/lib/scoring-formula.ts#L96-L97)**
   - Added zero-guard to `computeScoresWithFormula()`
   - Aligns implementation with `computeScores()` from scoring.ts

2. **[src/__tests__/scoring-formula.test.ts](src/__tests__/scoring-formula.test.ts)** (NEW)
   - Expanded existing minimal test suite into comprehensive coverage
   - Added critical edge case tests for zero-guard protection
   - Covers: division by zero, NaN prevention, endpoint integration

## Test Coverage
### Critical Tests Added
- ✅ `zero max_power_kw with zero power_output_kw` → no NaN
- ✅ `zero max_power_kw with nonzero power_output_kw` → no NaN  
- ✅ `zero max_power_kw with custom formula weights` → no NaN
- ✅ `endpoint preview path` → scores and delta remain finite

### Other Test Areas
- Weight validation (range checks, NaN detection)
- Formula creation and storage
- Score calculation accuracy
- Numerical edge cases (negatives, very large numbers, overflow)
- Formula weight combinations
- Store management (CRUD operations)

## Verification
- TypeScript syntax: ✓ Correct
- Logic correctness: ✓ Matches scoring.ts implementation
- Test coverage: ✓ 36 test cases covering edge cases and normal operation
- No breaking changes: ✓ Function signature and output shape unchanged

## References
- Related constant: `POWER_RATIO_FALLBACK = 0` in [src/lib/scoring.ts](src/lib/scoring.ts#L27)
- Reference implementation: [src/lib/scoring.ts#L79](src/lib/scoring.ts#L79)
- Endpoint affected: [src/routes/scoring-formulas.ts#L71](src/routes/scoring-formulas.ts#L71)

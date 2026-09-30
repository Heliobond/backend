# Oracle Service Level Objectives (SLOs)

This document defines the Service Level Objectives for the Heliobond oracle that submits impact scores to the Stellar blockchain.

## Overview

The oracle is a critical component of the Heliobond platform. It computes and submits impact scores for solar projects on-chain. These scores directly influence bond pricing, so score freshness and submission reliability are essential to product correctness.

## Defined SLOs

### 1. Score Freshness

**Objective**: 99% of active projects should have scores updated within 2 hours.

**Measurement**:
- Metric: `oracle_score_age_seconds{project_id}`
- Sample: All active projects (projects with at least one investor)
- Time window: Rolling 24-hour window

**What it means**:
- The oracle fetches the latest `last_update_timestamp` from the on-chain registry
- Score age = current time - `last_update_timestamp`
- 99% of projects must have score age ≤ 7200 seconds (2 hours)

**Why it matters**:
Investors use these scores to price bonds. Stale scores can lead to mispriced securities and loss of confidence in the platform.

### 2. Submission Success Rate

**Objective**: Oracle submission success rate of at least 99% over 7 days.

**Measurement**:
- Metric: `stellar_tx_submissions_total{result}`
- Calculation: `success_count / (success_count + failure_count)`
- Time window: Rolling 7-day window

**What it means**:
- Of all transaction submission attempts, at least 99% must succeed
- Failures include: RPC timeouts, sequence conflicts, insufficient XLM, contract errors
- Does not include deferred submissions (those go to the retry queue)

**Why it matters**:
A low success rate indicates systemic problems (stuck sequence number, insufficient balance, registry paused) that prevent scores from being updated.

### 3. Signer Balance

**Objective**: Oracle signer account must maintain sufficient XLM balance for fees.

**Measurement**:
- Metric: `oracle_signer_balance_xlm`
- Threshold: Alert if balance falls below 100 XLM
- Time window: Real-time

**What it means**:
- The oracle signer account pays transaction fees for all score updates
- Each transaction costs ~0.01 XLM (network fee + resource fees)
- With 100 XLM minimum, the oracle can submit ~10,000 transactions before running out

**Why it matters**:
If the account runs out of XLM, all submissions will fail until the account is refilled.

### 4. Registry Paused State

**Objective**: Registry should not be paused for more than 15 minutes unexpectedly.

**Measurement**:
- Metric: `registry_paused` (0=active, 1=paused)
- Alert: If paused for >15 minutes
- Time window: Real-time

**Why it matters**:
While the registry is paused, all score updates are rejected, causing scores to become stale.

## Monitoring Dashboard

The `/v1/status/oracle` endpoint provides a real-time summary for frontend status badges and operational dashboards.

## Incident Response

### Score Staleness

1. Check `/metrics` for `oracle_score_age_seconds` by project
2. Review recent cron logs for errors
3. Check if specific projects are consistently failing
4. Verify RPC connectivity and contract availability

### High Failure Rate

1. Check signer balance (`oracle_signer_balance_xlm`)
2. Review error logs for common failure patterns
3. Check if registry is paused (`registry_paused`)
4. Verify contract state and network conditions

### Low Balance

1. Transfer XLM to the oracle signer account
2. Monitor balance going forward
3. Consider automated balance alerts

### Registry Paused

1. Determine if pause was planned
2. If unplanned, investigate contract state
3. Unpause the registry if safe to do so
4. Monitor for score staleness after unpause

## Review and Updates

These SLOs should be reviewed quarterly and adjusted based on operational experience and user feedback.

Last updated: 2026-09-30

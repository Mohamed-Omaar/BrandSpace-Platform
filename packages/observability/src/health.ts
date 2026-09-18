/**
 * LIVENESS AND READINESS — Phase 10 §19.
 *
 * THE TWO QUESTIONS ARE DIFFERENT, and conflating them is how a deployment
 * ends up either restarting healthy processes or sending traffic to broken
 * ones:
 *
 *   LIVENESS  — is this process alive? If the answer is no, restart it.
 *               It must depend on NOTHING external. A liveness probe that
 *               checks the database restarts every process in the fleet when
 *               the database blinks, which turns a brief dependency problem
 *               into a total outage.
 *
 *   READINESS — can this process serve traffic right now? If the answer is no,
 *               take it out of the load balancer but LEAVE IT RUNNING.
 *
 * AND A THIRD STATE THAT MATTERS MORE THAN EITHER. Most real failures are
 * partial: object storage is unreachable, so uploads fail and everything else
 * works. Answering "not ready" there would take a working product offline to
 * protect one feature. So a dependency declares whether it is REQUIRED — the
 * platform cannot serve without it — or whether losing it DEGRADES one
 * capability, and the evaluation says which capabilities are affected instead
 * of pretending the whole platform is down.
 *
 * WHAT THIS MODULE DOES NOT DO. It performs no I/O and knows no vendor. The
 * caller supplies probes; this decides what their answers mean. That is what
 * lets the API route and the Control Center health screen reach the same
 * verdict from the same rules rather than from two similar-looking screens.
 */

export type DependencyState = 'ok' | 'degraded' | 'down' | 'not_configured' | 'unknown';

export interface DependencyCheck {
  /** Stable machine name — `database`, `queue`, `storage`, `integrations`. */
  readonly name: string;
  readonly state: DependencyState;
  /**
   * Whether the platform can serve traffic at all without it.
   *
   * Required dependencies decide readiness. Optional ones decide DEGRADATION,
   * which is a report rather than a refusal.
   */
  readonly required: boolean;
  /** Which product capability suffers when this is not `ok`. */
  readonly capability?: string;
  readonly latencyMs?: number;
  /**
   * Operator-facing detail.
   *
   * NEVER returned to an unauthenticated caller: a hostname, a role name or a
   * driver error tells somebody probing the platform how it is built.
   * `publicView` below is what the open endpoint answers with.
   */
  readonly detail?: string;
}

export type ReadinessStatus = 'ready' | 'degraded' | 'not_ready';

export interface HealthReport {
  readonly status: ReadinessStatus;
  readonly checks: readonly DependencyCheck[];
  /** Capabilities that are currently unavailable or reduced. */
  readonly degradedCapabilities: readonly string[];
}

/**
 * Decide what a set of probe results means.
 *
 * `not_configured` is treated as DOWN for a required dependency and as
 * degradation for an optional one, which is the honest reading of both: a
 * platform with no object storage configured cannot store an upload, and one
 * with no trace exporter configured simply is not exporting traces.
 */
export function evaluateHealth(checks: readonly DependencyCheck[]): HealthReport {
  const failing = (check: DependencyCheck): boolean =>
    check.state === 'down' || check.state === 'not_configured';

  const requiredDown = checks.some((check) => check.required && failing(check));
  const anyImpaired = checks.some((check) => check.state !== 'ok' && check.state !== 'unknown');

  const degradedCapabilities = [
    ...new Set(
      checks
        .filter((check) => check.state !== 'ok' && check.capability)
        .map((check) => check.capability as string),
    ),
  ].sort();

  const status: ReadinessStatus = requiredDown ? 'not_ready' : anyImpaired ? 'degraded' : 'ready';

  return { status, checks, degradedCapabilities };
}

/**
 * The report as an UNAUTHENTICATED caller may see it.
 *
 * A load balancer needs one word and the name of each check. It does not need
 * the database role, the storage endpoint or the text of a driver error — all
 * of which tell somebody probing the platform how it is assembled. The full
 * report, with details, is for the Control Center, which requires a platform
 * session to reach.
 */
export function publicView(report: HealthReport): {
  status: ReadinessStatus;
  checks: { name: string; state: DependencyState }[];
} {
  return {
    status: report.status,
    checks: report.checks.map((check) => ({ name: check.name, state: check.state })),
  };
}

/** The HTTP status a readiness verdict deserves. */
export function readinessHttpStatus(status: ReadinessStatus): number {
  /*
   * DEGRADED IS 200, DELIBERATELY. A 503 removes the instance from the load
   * balancer, and removing every instance because object storage is unreachable
   * would replace a broken upload button with a completely unreachable product.
   * Only a REQUIRED dependency being down earns a 503.
   */
  return status === 'not_ready' ? 503 : 200;
}

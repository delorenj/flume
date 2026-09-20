/** Canonical manifests own execution; derived registry fields never activate it. */
export const EXECUTION_LANES = ['Backlog', 'Needs Re-evaluation', 'Todo', 'In Progress', 'E2E Testing & QA', 'Ready for Documentation', 'Done', 'Needs Attention', 'Cancelled'];
export function executionReadiness(manifest: Record<string, any>): string[] {
  const execution = manifest.execution;
  if (!execution || execution.mode === 'legacy') return [];
  const errors: string[] = [];
  if (!['shadow','managed'].includes(execution.mode)) errors.push('execution.mode must be legacy, shadow or managed');
  if (!manifest.project_id) errors.push('canonical project_id missing');
  if (manifest.ticket_provider?.type !== 'plane' || !manifest.ticket_provider.workspace || !manifest.ticket_provider.board_id) errors.push('exact Plane binding missing');
  if (execution.policy_version !== 2 || !execution.skill_version) errors.push('execution policy or skill pin missing');
  for (const lane of EXECUTION_LANES) if (!execution.states?.[lane]) errors.push(`lane binding missing: ${lane}`);
  for (const pin of ['pilot_bundle_sha256','momo_bundle_sha256']) if (!/^[a-f0-9]{64}$/.test(execution[pin] ?? '')) errors.push(`${pin} missing`);
  if (!execution.working_label) errors.push('working label binding missing');
  if (!execution.actors?.[execution.pm_actor] || execution.actors[execution.pm_actor].role !== 'pm') errors.push('PM actor enrollment missing');
  if (!execution.actors?.[execution.controller_actor] || execution.actors[execution.controller_actor].role !== 'operator') errors.push('controller repair actor enrollment missing');
  const ids = new Set<string>();
  for (const [name, actor] of Object.entries(execution.actors ?? {}) as [string, any][]) {
    if (!actor.native_user_id || !actor.key_ref?.startsWith('op://') || !actor.runtime_id) errors.push(`actor ${name}: native identity, op reference and runtime required`);
    if (ids.has(actor.native_user_id)) errors.push(`actor ${name}: duplicate native identity`);
    ids.add(actor.native_user_id);
    if (!['pm','operator','reviewer','interactive'].includes(actor.role)) errors.push(`actor ${name}: invalid role`);
    if (name===execution.pm_actor && (!Array.isArray(actor.runtime?.planner_argv) || !actor.runtime.planner_argv.length || actor.runtime.planner_argv.some((x:any)=>typeof x!=='string' || !x || x.includes('\0')))) errors.push('PM planner argv missing');
    if (actor.runtime?.adapter !== 'systemd' || !/^[a-zA-Z0-9_-]+$/.test(actor.runtime?.unit_prefix ?? '')) errors.push(`actor ${name}: supervised runtime missing`);
  }
  if (execution.legacy_writers_fenced !== true) errors.push('legacy writers not fenced');
  return errors;
}
export function validateExecutionBinding(manifest: Record<string, any>): void {
  if (!manifest.execution) return;
  if (typeof manifest.execution !== 'object' || Array.isArray(manifest.execution)) throw new Error('execution must be an object');
  // Shadow enrollment can be incrementally filled; activation cannot be partial.
  if (manifest.execution.mode === 'managed') {
    const errors = executionReadiness(manifest);
    if (errors.length) throw new Error(`Managed execution not ready: ${errors.join('; ')}`);
  } else if (!['legacy','shadow'].includes(manifest.execution.mode)) throw new Error('invalid execution mode');
}

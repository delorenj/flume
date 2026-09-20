import { HireRecipe } from "../hire/HireRecipe";
import { OrgReconcileRecipe } from "./reconcile";
import { RecipeRegistry } from "../engine/registry";

/**
 * Flume's production registry.
 *
 * pjangler has its own, holding the eight project recipes. The two are
 * deliberately separate instances over the same engine: rule ownership is what
 * `ownerOf()` answers, and after the split neither tool should be able to
 * answer for the other's rules. `org/status.ts` consults THIS one -- it relies
 * on the documented invariant that the registry answers for every rule it is
 * asked about, so pointing it at pjangler's would make it return null for every
 * employee finding.
 *
 * TWO RECIPES, TWO ALTITUDES, and the split is the point.
 *
 * `hire` owns the rules about ONE repository -- every check it declares opens
 * with `discoverRoles(ctx.repoRoot)`. `org-reconcile` owns the rules about the
 * shared registries, which no repository can answer for: they are what
 * `flume roster` reports and what `flume remediate --all` repairs. Bolting the
 * org-wide rules onto `hire` would have made hiring an agent depend on the state of
 * fifteen other repositories.
 */
export const recipeRegistry = new RecipeRegistry([new HireRecipe(), new OrgReconcileRecipe()]);

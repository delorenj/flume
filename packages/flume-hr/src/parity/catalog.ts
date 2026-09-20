import { HireRecipe } from "../hire/HireRecipe";
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
 */
export const recipeRegistry = new RecipeRegistry([new HireRecipe()]);

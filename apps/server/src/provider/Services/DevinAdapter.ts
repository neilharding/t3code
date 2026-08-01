/**
 * DevinAdapter — shape type for the Devin provider adapter.
 *
 * Follows the driver-bundled-closure model described in
 * {@link ../Services/CursorAdapter.ts} — the tag is gone, this interface is
 * only a naming anchor for the driver bundle.
 *
 * @module DevinAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * DevinAdapterShape — per-instance Devin adapter contract. Carries a
 * branded driver kind as the nominal discriminant.
 */
export interface DevinAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}

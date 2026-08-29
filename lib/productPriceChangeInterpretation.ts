import type { ProductIdentityLevel } from './productIdentityContract';
import type { ProductDetailTarget } from './productDetailTarget';
import type {
  ProductPriceHistoryObservation,
  ProductPriceHistoryPoint,
  ProductPriceHistoryResult,
  PersonalProductPriceAuthority,
} from './productPriceHistory';
import type { PricePromoContext } from './priceObservationTruth';

export type ProductPriceChangeUnavailableReason =
  | 'history_not_ready'
  | 'series_not_gross'
  | 'duplicate_selection_unconfirmed'
  | 'identity_not_exact'
  | 'quality_not_trusted'
  | 'not_enough_distinct_purchase_events'
  | 'ambiguous_same_timestamp'
  | 'price_kind_mismatch'
  | 'amount_basis_mismatch'
  | 'invalid_price'
  | 'unsafe_same_receipt_aggregation'
  | 'invalid_timestamp'
  | 'latest_purchase_not_comparable'
  | 'purchase_observation_history_incomplete';

export type ProductPriceChangeIdentityAuthority =
  | { kind: 'sku'; skuKey: string }
  | {
      kind: 'merchant_product';
      merchantProductId: string;
      merchantScopeKey: string;
    }
  | {
      kind: 'personal_product';
      anchorMerchantProductId: string;
      memberMerchantProductIds: string[];
    };

export type ProductPriceChangePromoState =
  | 'explicit_discount'
  | 'explicit_discount_and_marker'
  | 'qualitative_marker'
  | 'none_observed'
  | 'unknown';

export type ProductPriceChangePromoTransition =
  | 'ended'
  | 'started'
  | 'present_both'
  | 'none'
  | 'unknown';

export type ProductPriceChangePurchaseEvent = {
  receiptId: string;
  occurredAt: number;
  priceValue: number;
  grossLineAmount: number;
  purchaseQuantity: number;
  currency: string;
  priceKind: NonNullable<ProductPriceHistoryResult['priceKind']>;
  amountBasis: 'tax_included' | 'tax_excluded';
  promoContext: PricePromoContext;
  promoState: ProductPriceChangePromoState;
  discountAllocated: number | null;
  effectiveLineAmount: number | null;
  skuKey?: string | null;
  merchantProductId?: string | null;
  identityLevel?: ProductIdentityLevel | null;
  merchantScopeKey?: string | null;
};

export type ProductPriceChangeInterpretation =
  | {
      status: 'unavailable';
      reasonCodes: ProductPriceChangeUnavailableReason[];
    }
  | {
      status: 'available';
      identityAuthority: ProductPriceChangeIdentityAuthority;
      previous: ProductPriceChangePurchaseEvent;
      current: ProductPriceChangePurchaseEvent;
      grossDirection: 'unchanged' | 'increased' | 'decreased';
      grossDelta: number;
      promoTransition: ProductPriceChangePromoTransition;
      previousPromo: ProductPriceChangePromoState;
      currentPromo: ProductPriceChangePromoState;
      previousDiscountAllocated: number | null;
      currentDiscountAllocated: number | null;
    };

export type InterpretProductPriceChangeInput = {
  history: ProductPriceHistoryResult;
  targetType: ProductDetailTarget['type'];
  targetKey: string;
};

function positiveFinite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function validPositiveTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export type ObservedPurchaseEvent = {
  receiptId: string;
  occurredAt: number;
};

export type ReceiptEventTimelineEntry = {
  receiptId: string;
  occurredAt: number;
};

function collapseRowsToReceiptEvents<
  T extends { receiptId: string; occurredAt: number },
>(rows: readonly T[]): ReceiptEventTimelineEntry[] {
  const byReceipt = new Map<string, number>();
  for (const row of rows) {
    const existing = byReceipt.get(row.receiptId);
    byReceipt.set(
      row.receiptId,
      existing == null ? row.occurredAt : Math.max(existing, row.occurredAt)
    );
  }
  return [...byReceipt.entries()]
    .map(([receiptId, occurredAt]) => ({ receiptId, occurredAt }))
    .sort(
      (left, right) =>
        left.occurredAt - right.occurredAt ||
        left.receiptId.localeCompare(right.receiptId)
    );
}

export function buildObservedPurchaseEventIndex(
  observations: readonly ProductPriceHistoryObservation[]
):
  | { ok: true; events: ObservedPurchaseEvent[] }
  | { ok: false; reason: 'invalid_timestamp' } {
  for (const observation of observations) {
    if (!validPositiveTimestamp(observation.occurredAt)) {
      return { ok: false, reason: 'invalid_timestamp' };
    }
  }
  return {
    ok: true,
    events: collapseRowsToReceiptEvents(observations),
  };
}

function validatePointTimestamps(
  points: readonly ProductPriceHistoryPoint[]
): ProductPriceChangeUnavailableReason | null {
  for (const point of points) {
    if (!validPositiveTimestamp(point.occurredAt)) {
      return 'invalid_timestamp';
    }
  }
  return null;
}

function distinctReceiptIdsAtTimestamp(
  events: readonly ReceiptEventTimelineEntry[],
  occurredAt: number
): string[] {
  return [
    ...new Set(
      events
        .filter((event) => machineEqual(event.occurredAt, occurredAt))
        .map((event) => event.receiptId)
    ),
  ];
}

function verifyLatestPurchaseBoundary(
  observedEvents: readonly ObservedPurchaseEvent[],
  comparableEvents: readonly ReceiptEventTimelineEntry[]
): ProductPriceChangeUnavailableReason | null {
  if (observedEvents.length === 0 || comparableEvents.length === 0) {
    return null;
  }

  const maxObservedAt = observedEvents[observedEvents.length - 1]!.occurredAt;
  const observedAtMax = distinctReceiptIdsAtTimestamp(
    observedEvents,
    maxObservedAt
  );
  if (observedAtMax.length > 1) {
    return 'ambiguous_same_timestamp';
  }

  const maxComparableAt =
    comparableEvents[comparableEvents.length - 1]!.occurredAt;
  const comparableAtMax = distinctReceiptIdsAtTimestamp(
    comparableEvents,
    maxComparableAt
  );
  if (comparableAtMax.length > 1) {
    return 'ambiguous_same_timestamp';
  }

  const latestObservedReceiptId = observedAtMax[0]!;
  const latestComparableReceiptId = comparableAtMax[0]!;

  if (latestObservedReceiptId !== latestComparableReceiptId) {
    if (machineEqual(maxObservedAt, maxComparableAt)) {
      return 'ambiguous_same_timestamp';
    }
    return 'latest_purchase_not_comparable';
  }

  return null;
}

function verifyPurchaseObservationTimeline(
  observations: readonly ProductPriceHistoryObservation[],
  observedEvents: readonly ObservedPurchaseEvent[],
  comparableEvents: readonly ReceiptEventTimelineEntry[]
): ProductPriceChangeUnavailableReason | null {
  if (observations.length === 0) {
    return 'purchase_observation_history_incomplete';
  }

  const observedReceiptIds = new Set(
    observedEvents.map((event) => event.receiptId)
  );
  for (const event of comparableEvents) {
    if (!observedReceiptIds.has(event.receiptId)) {
      return 'purchase_observation_history_incomplete';
    }
  }

  return verifyLatestPurchaseBoundary(observedEvents, comparableEvents);
}

function machineEqual(a: number, b: number): boolean {
  if (a === b) return true;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= Number.EPSILON * scale;
}

function promoStateFromContext(
  promoContext: PricePromoContext | null | undefined
): ProductPriceChangePromoState {
  switch (promoContext) {
    case 'explicit_discount':
      return 'explicit_discount';
    case 'explicit_discount_and_marker':
      return 'explicit_discount_and_marker';
    case 'qualitative_marker':
      return 'qualitative_marker';
    case 'none_observed':
      return 'none_observed';
    default:
      return 'unknown';
  }
}

function isPromoBearing(state: ProductPriceChangePromoState): boolean {
  return (
    state === 'explicit_discount' ||
    state === 'explicit_discount_and_marker' ||
    state === 'qualitative_marker'
  );
}

function aggregatePromoStates(
  states: readonly ProductPriceChangePromoState[]
): ProductPriceChangePromoState {
  if (states.some((state) => state === 'unknown')) {
    const hasPositivePromo = states.some((state) => isPromoBearing(state));
    return hasPositivePromo ? states.find((state) => isPromoBearing(state))! : 'unknown';
  }
  const bearing = states.filter((state) => isPromoBearing(state));
  if (bearing.length === 0) {
    return states.every((state) => state === 'none_observed')
      ? 'none_observed'
      : 'unknown';
  }
  if (bearing.some((state) => state === 'explicit_discount_and_marker')) {
    return 'explicit_discount_and_marker';
  }
  if (bearing.some((state) => state === 'explicit_discount')) {
    return 'explicit_discount';
  }
  return 'qualitative_marker';
}

function aggregateDiscountAllocated(
  points: readonly ProductPriceHistoryPoint[],
  promoState: ProductPriceChangePromoState
): number | null {
  if (
    promoState !== 'explicit_discount' &&
    promoState !== 'explicit_discount_and_marker'
  ) {
    return null;
  }
  let sum = 0;
  let seen = false;
  for (const point of points) {
    const value = point.discountAllocated;
    if (value == null || typeof value !== 'number' || !Number.isFinite(value)) {
      continue;
    }
    if (value >= 0) continue;
    sum += value;
    seen = true;
  }
  return seen ? sum : null;
}

function aggregateEffectiveLineAmount(
  points: readonly ProductPriceHistoryPoint[]
): number | null {
  let sum = 0;
  let seen = false;
  for (const point of points) {
    const value = point.effectiveLineAmount;
    if (value == null || !Number.isFinite(value)) continue;
    sum += value;
    seen = true;
  }
  return seen ? sum : null;
}

function promoTransitionBetween(
  previous: ProductPriceChangePromoState,
  current: ProductPriceChangePromoState
): ProductPriceChangePromoTransition {
  if (previous === 'unknown' || current === 'unknown') return 'unknown';
  const prevBearing = isPromoBearing(previous);
  const currBearing = isPromoBearing(current);
  if (prevBearing && !currBearing && current === 'none_observed') return 'ended';
  if (!prevBearing && previous === 'none_observed' && currBearing) return 'started';
  if (prevBearing && currBearing) return 'present_both';
  if (!prevBearing && !currBearing) return 'none';
  return 'unknown';
}

function grossDirectionFromDelta(
  delta: number
): 'unchanged' | 'increased' | 'decreased' {
  if (machineEqual(delta, 0)) return 'unchanged';
  return delta > 0 ? 'increased' : 'decreased';
}

function pointToEvent(point: ProductPriceHistoryPoint): ProductPriceChangePurchaseEvent {
  const promoState = promoStateFromContext(point.promoContext);
  return {
    receiptId: point.receiptId,
    occurredAt: point.occurredAt,
    priceValue: point.priceValue,
    grossLineAmount: point.grossLineAmount,
    purchaseQuantity: point.purchaseQuantity,
    currency: point.currency,
    priceKind: point.priceKind,
    amountBasis: point.amountBasis as 'tax_included' | 'tax_excluded',
    promoContext: point.promoContext ?? 'unknown',
    promoState,
    discountAllocated: aggregateDiscountAllocated([point], promoState),
    effectiveLineAmount: point.effectiveLineAmount ?? null,
    skuKey: point.skuKey ?? null,
    merchantProductId: point.merchantProductId ?? null,
    identityLevel: point.identityLevel ?? null,
    merchantScopeKey: point.merchantScopeKey ?? null,
  };
}

function skuIdentityAuthorized(
  point: ProductPriceHistoryPoint,
  targetKey: string
): boolean {
  return point.skuKey === targetKey;
}

function merchantIdentityAuthorized(
  point: ProductPriceHistoryPoint,
  targetKey: string,
  scopeKey: string | null
): boolean {
  return (
    point.merchantProductId === targetKey &&
    point.identityLevel === 'merchant_product' &&
    point.merchantScopeKey === scopeKey
  );
}

type ExactPointAuthorizer = (point: ProductPriceHistoryPoint) => boolean;

function isValidOpaqueIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function personalIdentityAuthorized(
  point: ProductPriceHistoryPoint,
  certificate: PersonalProductPriceAuthority
): boolean {
  if (!isValidOpaqueIdentifier(point.itemId)) {
    return false;
  }
  if (!isValidOpaqueIdentifier(point.merchantProductId)) {
    return false;
  }
  if (!validCertificateSourceIndex(point.sourceIndex)) {
    return false;
  }

  const entry = certificate.authorizedRows.find(
    (row) =>
      row.receiptId === point.receiptId && row.sourceIndex === point.sourceIndex
  );
  if (!entry) {
    return false;
  }

  if (!isValidOpaqueIdentifier(entry.itemId)) {
    return false;
  }
  if (!isValidOpaqueIdentifier(entry.merchantProductId)) {
    return false;
  }

  if (point.itemId !== entry.itemId) {
    return false;
  }
  if (point.merchantProductId !== entry.merchantProductId) {
    return false;
  }
  if (!certificate.memberMerchantProductIds.includes(entry.merchantProductId)) {
    return false;
  }

  return true;
}

function validCertificateSourceIndex(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

function certificateRowKey(receiptId: string, sourceIndex: number): string {
  return `${receiptId}:${sourceIndex}`;
}

function validatePersonalProductCertificate(
  certificate: PersonalProductPriceAuthority | null | undefined,
  targetKey: string,
  observations: readonly ProductPriceHistoryObservation[],
  points: readonly ProductPriceHistoryPoint[]
): ProductPriceChangeUnavailableReason | null {
  if (!certificate) {
    return 'identity_not_exact';
  }
  if (
    certificate.kind !== 'personal_product' ||
    certificate.identityLevel !== 'product_exact' ||
    certificate.sourceTier !== 'personal_manual'
  ) {
    return 'identity_not_exact';
  }

  const anchorMerchantProductId = isValidOpaqueIdentifier(
    certificate.anchorMerchantProductId
  )
    ? certificate.anchorMerchantProductId
    : null;
  if (!anchorMerchantProductId) {
    return 'identity_not_exact';
  }

  if (
    !certificate.memberMerchantProductIds.every((memberId) =>
      isValidOpaqueIdentifier(memberId)
    )
  ) {
    return 'identity_not_exact';
  }
  const uniqueMemberIds = [...new Set(certificate.memberMerchantProductIds)].sort();
  if (
    uniqueMemberIds.length === 0 ||
    uniqueMemberIds.length !== certificate.memberMerchantProductIds.length
  ) {
    return 'identity_not_exact';
  }
  if (!uniqueMemberIds.includes(anchorMerchantProductId)) {
    return 'identity_not_exact';
  }

  if (!isValidOpaqueIdentifier(targetKey) || !uniqueMemberIds.includes(targetKey)) {
    return 'identity_not_exact';
  }

  const certificateIndex = new Map<
    string,
    PersonalProductPriceAuthority['authorizedRows'][number]
  >();

  for (const row of certificate.authorizedRows) {
    if (
      !isValidOpaqueIdentifier(row.receiptId) ||
      !isValidOpaqueIdentifier(row.itemId) ||
      !isValidOpaqueIdentifier(row.merchantProductId) ||
      !validCertificateSourceIndex(row.sourceIndex)
    ) {
      return 'identity_not_exact';
    }
    if (!uniqueMemberIds.includes(row.merchantProductId)) {
      return 'identity_not_exact';
    }

    const key = certificateRowKey(row.receiptId, row.sourceIndex);
    const existing = certificateIndex.get(key);
    if (existing) {
      if (
        existing.itemId !== row.itemId ||
        existing.merchantProductId !== row.merchantProductId
      ) {
        return 'identity_not_exact';
      }
      continue;
    }
    certificateIndex.set(key, row);
  }

  for (const observation of observations) {
    if (
      !isValidOpaqueIdentifier(observation.receiptId) ||
      !validCertificateSourceIndex(observation.sourceIndex)
    ) {
      return 'identity_not_exact';
    }
    const entry = certificateIndex.get(
      certificateRowKey(observation.receiptId, observation.sourceIndex)
    );
    if (!entry) {
      return 'identity_not_exact';
    }
    if (!uniqueMemberIds.includes(entry.merchantProductId)) {
      return 'identity_not_exact';
    }
  }

  for (const point of points) {
    if (!personalIdentityAuthorized(point, certificate)) {
      return 'identity_not_exact';
    }
  }

  return null;
}

function collapseReceiptPoints(
  points: readonly ProductPriceHistoryPoint[],
  authorizer: ExactPointAuthorizer
):
  | { ok: true; event: ProductPriceChangePurchaseEvent }
  | { ok: false; reason: ProductPriceChangeUnavailableReason } {
  if (points.length === 1) {
    if (!authorizer(points[0]!)) {
      return { ok: false, reason: 'identity_not_exact' };
    }
    return { ok: true, event: pointToEvent(points[0]!) };
  }

  const priceKind = points[0]!.priceKind;
  const currency = points[0]!.currency;
  const amountBasis = points[0]!.amountBasis;
  if (priceKind !== 'purchase_unit') {
    return { ok: false, reason: 'unsafe_same_receipt_aggregation' };
  }

  for (const point of points) {
    if (point.priceKind !== priceKind) {
      return { ok: false, reason: 'price_kind_mismatch' };
    }
    if (point.currency !== currency) {
      return { ok: false, reason: 'price_kind_mismatch' };
    }
    if (point.amountBasis !== amountBasis) {
      return { ok: false, reason: 'amount_basis_mismatch' };
    }
    if (point.qualityLevel !== 'trusted') {
      return { ok: false, reason: 'quality_not_trusted' };
    }
    if (
      !positiveFinite(point.grossLineAmount) ||
      !positiveFinite(point.purchaseQuantity) ||
      !positiveFinite(point.priceValue)
    ) {
      return { ok: false, reason: 'invalid_price' };
    }
    if (!authorizer(point)) {
      return { ok: false, reason: 'identity_not_exact' };
    }
  }

  const promoStates = points.map((point) =>
    promoStateFromContext(point.promoContext)
  );
  const promoState = aggregatePromoStates(promoStates);
  const grossLineAmount = points.reduce(
    (sum, point) => sum + point.grossLineAmount,
    0
  );
  const purchaseQuantity = points.reduce(
    (sum, point) => sum + point.purchaseQuantity,
    0
  );
  if (!positiveFinite(grossLineAmount) || !positiveFinite(purchaseQuantity)) {
    return { ok: false, reason: 'invalid_price' };
  }
  const priceValue = grossLineAmount / purchaseQuantity;
  if (!positiveFinite(priceValue)) {
    return { ok: false, reason: 'invalid_price' };
  }

  return {
    ok: true,
    event: {
      receiptId: points[0]!.receiptId,
      occurredAt: Math.max(...points.map((point) => point.occurredAt)),
      priceValue,
      grossLineAmount,
      purchaseQuantity,
      currency: currency!,
      priceKind,
      amountBasis: amountBasis as 'tax_included' | 'tax_excluded',
      promoContext: points[points.length - 1]!.promoContext ?? 'unknown',
      promoState,
      discountAllocated: aggregateDiscountAllocated(points, promoState),
      effectiveLineAmount: aggregateEffectiveLineAmount(points),
      skuKey: points[0]!.skuKey ?? null,
      merchantProductId: points[0]!.merchantProductId ?? null,
      identityLevel: points[0]!.identityLevel ?? null,
      merchantScopeKey: points[0]!.merchantScopeKey ?? null,
    },
  };
}

function collapsePointsToEvents(
  points: readonly ProductPriceHistoryPoint[],
  authorizer: ExactPointAuthorizer
):
  | { ok: true; events: ProductPriceChangePurchaseEvent[] }
  | { ok: false; reason: ProductPriceChangeUnavailableReason } {
  const byReceipt = new Map<string, ProductPriceHistoryPoint[]>();
  for (const point of points) {
    const list = byReceipt.get(point.receiptId) ?? [];
    list.push(point);
    byReceipt.set(point.receiptId, list);
  }

  const events: ProductPriceChangePurchaseEvent[] = [];
  for (const receiptPoints of byReceipt.values()) {
    const collapsed = collapseReceiptPoints(receiptPoints, authorizer);
    if (!collapsed.ok) return collapsed;
    events.push(collapsed.event);
  }

  events.sort(
    (left, right) =>
      left.occurredAt - right.occurredAt ||
      left.receiptId.localeCompare(right.receiptId)
  );
  return { ok: true, events };
}

function unavailable(
  ...reasonCodes: ProductPriceChangeUnavailableReason[]
): ProductPriceChangeInterpretation {
  return { status: 'unavailable', reasonCodes: [...new Set(reasonCodes)] };
}

export function interpretProductPriceChange(
  input: InterpretProductPriceChangeInput
): ProductPriceChangeInterpretation {
  const { history, targetType, targetKey } = input;

  if (
    targetType !== 'sku' &&
    targetType !== 'merchant_product' &&
    targetType !== 'personal_product'
  ) {
    return unavailable('identity_not_exact');
  }

  if (history.status !== 'ready') {
    return unavailable('history_not_ready');
  }
  if (history.seriesKind !== 'gross') {
    return unavailable('series_not_gross');
  }
  if (
    history.amountBasis !== 'tax_included' &&
    history.amountBasis !== 'tax_excluded'
  ) {
    return unavailable('amount_basis_mismatch');
  }
  if (history.canonicalDuplicateSelectionApplied !== true) {
    return unavailable('duplicate_selection_unconfirmed');
  }

  const observedIndex = buildObservedPurchaseEventIndex(history.observations);
  if (!observedIndex.ok) {
    return unavailable(observedIndex.reason);
  }

  const pointTimestampIssue = validatePointTimestamps(history.points);
  if (pointTimestampIssue) {
    return unavailable(pointTimestampIssue);
  }

  const comparableReceiptTimeline = collapseRowsToReceiptEvents(history.points);
  const timelineIssue = verifyPurchaseObservationTimeline(
    history.observations,
    observedIndex.events,
    comparableReceiptTimeline
  );
  if (timelineIssue) {
    return unavailable(timelineIssue);
  }

  const trustedPoints = history.points.filter(
    (point) => point.qualityLevel === 'trusted'
  );
  if (trustedPoints.length !== history.points.length) {
    return unavailable('quality_not_trusted');
  }

  if (trustedPoints.length === 0) {
    return unavailable('not_enough_distinct_purchase_events');
  }

  const priceKind = trustedPoints[0]!.priceKind;
  const currency = trustedPoints[0]!.currency;
  const amountBasis = history.amountBasis;

  for (const point of trustedPoints) {
    if (point.priceKind !== priceKind) {
      return unavailable('price_kind_mismatch');
    }
    if (point.currency !== currency) {
      return unavailable('price_kind_mismatch');
    }
    if (point.amountBasis !== amountBasis) {
      return unavailable('amount_basis_mismatch');
    }
    if (
      !positiveFinite(point.priceValue) ||
      !positiveFinite(point.grossLineAmount) ||
      !positiveFinite(point.purchaseQuantity)
    ) {
      return unavailable('invalid_price');
    }
  }

  let identityAuthority: ProductPriceChangeIdentityAuthority;
  let authorizer: ExactPointAuthorizer;

  if (targetType === 'personal_product') {
    const certificateIssue = validatePersonalProductCertificate(
      history.personalProductPriceAuthority,
      targetKey,
      history.observations,
      trustedPoints
    );
    if (certificateIssue) {
      return unavailable(certificateIssue);
    }
    const certificate = history.personalProductPriceAuthority!;
    authorizer = (point) => personalIdentityAuthorized(point, certificate);
    identityAuthority = {
      kind: 'personal_product',
      anchorMerchantProductId: certificate.anchorMerchantProductId,
      memberMerchantProductIds: [...certificate.memberMerchantProductIds],
    };
  } else if (targetType === 'sku') {
    if (!trustedPoints.every((point) => skuIdentityAuthorized(point, targetKey))) {
      return unavailable('identity_not_exact');
    }
    authorizer = (point) => skuIdentityAuthorized(point, targetKey);
    identityAuthority = { kind: 'sku', skuKey: targetKey };
  } else {
    const scopeKeys = new Set(
      trustedPoints
        .map((point) => point.merchantScopeKey)
        .filter((value): value is string => typeof value === 'string' && !!value)
    );
    if (scopeKeys.size !== 1) {
      return unavailable('identity_not_exact');
    }
    const merchantScopeKey = [...scopeKeys][0]!;
    if (
      !trustedPoints.every((point) =>
        merchantIdentityAuthorized(point, targetKey, merchantScopeKey)
      )
    ) {
      return unavailable('identity_not_exact');
    }
    authorizer = (point) =>
      merchantIdentityAuthorized(point, targetKey, merchantScopeKey);
    identityAuthority = {
      kind: 'merchant_product',
      merchantProductId: targetKey,
      merchantScopeKey,
    };
  }

  const collapsed = collapsePointsToEvents(trustedPoints, authorizer);
  if (!collapsed.ok) {
    return unavailable(collapsed.reason);
  }
  if (collapsed.events.length < 2) {
    return unavailable('not_enough_distinct_purchase_events');
  }

  const previous = collapsed.events[collapsed.events.length - 2]!;
  const current = collapsed.events[collapsed.events.length - 1]!;
  if (machineEqual(previous.occurredAt, current.occurredAt)) {
    return unavailable('ambiguous_same_timestamp');
  }

  const grossDelta = current.priceValue - previous.priceValue;
  const previousPromo = previous.promoState;
  const currentPromo = current.promoState;

  return {
    status: 'available',
    identityAuthority,
    previous,
    current,
    grossDirection: grossDirectionFromDelta(grossDelta),
    grossDelta,
    promoTransition: promoTransitionBetween(previousPromo, currentPromo),
    previousPromo,
    currentPromo,
    previousDiscountAllocated: previous.discountAllocated,
    currentDiscountAllocated: current.discountAllocated,
  };
}

import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Polyline } from 'react-native-svg';

import { formatDate } from '@/lib/formatDate';
import { t } from '@/lib/i18n';
import {
  buildPriceChartCoordinates,
  PRODUCT_PRICE_CHART_HEIGHT,
  PRODUCT_PRICE_CHART_PADDING_X,
  PRODUCT_PRICE_CHART_PADDING_Y,
} from '@/lib/productPriceChart';
import type {
  ProductPriceHistoryResult,
  ProductPriceKind,
} from '@/lib/productPriceHistory';

function numberLabel(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString()
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function unitLabel(priceKind: ProductPriceKind): string {
  return t(`priceHistory.unit.${priceKind}`);
}

function priceLabel(
  value: number,
  currency: string,
  priceKind: ProductPriceKind
): string {
  const amount =
    currency === 'JPY'
      ? `¥${numberLabel(value)}`
      : `${currency} ${numberLabel(value)}`;
  return `${amount}${unitLabel(priceKind)}`;
}

function statusMessageKey(
  status: ProductPriceHistoryResult['status']
): string {
  if (status === 'not_enough_points') return 'priceHistory.status.notEnough';
  if (status === 'unsupported_family') {
    return 'priceHistory.status.unsupportedFamily';
  }
  if (status === 'no_comparable_spec') {
    return 'priceHistory.status.noComparableSpec';
  }
  if (status === 'ambiguous_dimension') {
    return 'priceHistory.status.ambiguousDimension';
  }
  if (status === 'mixed_currency') {
    return 'priceHistory.status.mixedCurrency';
  }
  return 'priceHistory.status.unknownCurrency';
}

export function ProductPriceHistoryChart({
  result,
}: {
  result: ProductPriceHistoryResult;
}) {
  const [chartWidth, setChartWidth] = useState(0);
  const coordinates = useMemo(
    () => buildPriceChartCoordinates(result.points, chartWidth),
    [chartWidth, result.points]
  );
  const subtitleKey =
    result.identityPresentation?.subtitleKey ??
    (result.target.type === 'sku'
      ? 'priceHistory.subtitle.sku'
      : result.target.type === 'canonical'
        ? 'priceHistory.subtitle.canonical'
        : result.target.type === 'merchant_product'
          ? 'priceHistory.subtitle.merchantProduct'
          : 'priceHistory.subtitle.family');
  const titleKey =
    result.identityPresentation?.titleKey ?? 'priceHistory.title';
  const latest = result.points[result.points.length - 1];
  const minimumPoint =
    result.points.length > 0
      ? result.points.reduce((minimum, point) =>
          point.priceValue < minimum.priceValue ? point : minimum
        )
      : null;
  const maximumPoint =
    result.points.length > 0
      ? result.points.reduce((maximum, point) =>
          point.priceValue > maximum.priceValue ? point : maximum
        )
      : null;

  return (
    <>
      <Text style={styles.title}>{t(titleKey)}</Text>
      <Text style={styles.subtitle}>{t(subtitleKey)}</Text>

      {result.status !== 'ready' ? (
        <View style={styles.statusCard}>
          <Text style={styles.statusText}>
            {t(statusMessageKey(result.status))}
          </Text>
          {result.points.length === 1 && result.priceKind && result.currency && (
            <Text style={styles.singlePrice}>
              {priceLabel(
                result.points[0].priceValue,
                result.currency,
                result.priceKind
              )}
            </Text>
          )}
        </View>
      ) : (
        <>
          <View style={styles.unitRow}>
            <Text style={styles.unitCaption}>
              {t('priceHistory.priceUnit')}
            </Text>
            <Text style={styles.unitValue}>
              {t(`priceHistory.kind.${result.priceKind}`)}
            </Text>
          </View>
          <View
            style={styles.chart}
            onLayout={(event) => setChartWidth(event.nativeEvent.layout.width)}
          >
            {chartWidth > 0 && coordinates.length > 0 && (
              <Svg width={chartWidth} height={PRODUCT_PRICE_CHART_HEIGHT}>
                <Line
                  x1={PRODUCT_PRICE_CHART_PADDING_X}
                  y1={
                    PRODUCT_PRICE_CHART_HEIGHT -
                    PRODUCT_PRICE_CHART_PADDING_Y
                  }
                  x2={chartWidth - PRODUCT_PRICE_CHART_PADDING_X}
                  y2={
                    PRODUCT_PRICE_CHART_HEIGHT -
                    PRODUCT_PRICE_CHART_PADDING_Y
                  }
                  stroke="#d8d8d8"
                  strokeWidth={1}
                />
                <Polyline
                  points={coordinates
                    .map((coordinate) => `${coordinate.x},${coordinate.y}`)
                    .join(' ')}
                  fill="none"
                  stroke="#222"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {coordinates.map((coordinate, index) => (
                  <Circle
                    key={result.points[index].itemId}
                    cx={coordinate.x}
                    cy={coordinate.y}
                    r={3.5}
                    fill="#fff"
                    stroke="#222"
                    strokeWidth={2}
                  />
                ))}
              </Svg>
            )}
          </View>
          <View style={styles.dateRange}>
            <Text style={styles.dateLabel}>
              {formatDate(result.points[0].occurredAt).slice(0, 10)}
            </Text>
            <Text style={styles.dateLabel}>
              {formatDate(result.points[result.points.length - 1].occurredAt).slice(
                0,
                10
              )}
            </Text>
          </View>
          {latest && minimumPoint && maximumPoint && result.priceKind && result.currency && (
            <View style={styles.factGrid}>
              <View style={styles.fact}>
                <Text style={styles.factLabel}>{t('priceHistory.latest')}</Text>
                <Text style={styles.factValue}>
                  {priceLabel(
                    latest.priceValue,
                    result.currency,
                    result.priceKind
                  )}
                </Text>
              </View>
              <View style={styles.fact}>
                <Text style={styles.factLabel}>{t('priceHistory.minimum')}</Text>
                <Text style={styles.factValue}>
                  {priceLabel(
                    minimumPoint.priceValue,
                    result.currency,
                    result.priceKind
                  )}
                </Text>
              </View>
              <View style={styles.fact}>
                <Text style={styles.factLabel}>{t('priceHistory.maximum')}</Text>
                <Text style={styles.factValue}>
                  {priceLabel(
                    maximumPoint.priceValue,
                    result.currency,
                    result.priceKind
                  )}
                </Text>
              </View>
            </View>
          )}
        </>
      )}

      <Text style={styles.coverage}>
        {t('priceHistory.coverage', {
          comparable: result.comparableOccurrenceCount,
          total: result.totalOccurrenceCount,
          excluded: result.excludedOccurrenceCount,
        })}
      </Text>
    </>
  );
}

const styles = StyleSheet.create({
  title: {
    marginTop: 26,
    fontSize: 17,
    fontWeight: '800',
    color: '#111',
  },
  subtitle: {
    marginTop: 6,
    color: '#666',
    fontSize: 13,
    lineHeight: 19,
  },
  statusCard: {
    marginTop: 12,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#f3f3f3',
  },
  statusText: {
    color: '#555',
    fontSize: 14,
    lineHeight: 20,
  },
  singlePrice: {
    marginTop: 10,
    color: '#111',
    fontSize: 19,
    fontWeight: '800',
  },
  unitRow: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  unitCaption: {
    color: '#666',
    fontSize: 12,
  },
  unitValue: {
    color: '#222',
    fontSize: 13,
    fontWeight: '700',
  },
  chart: {
    marginTop: 6,
    height: PRODUCT_PRICE_CHART_HEIGHT,
    borderRadius: 12,
    backgroundColor: '#f7f7f7',
    overflow: 'hidden',
  },
  dateRange: {
    marginTop: 5,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  dateLabel: {
    color: '#777',
    fontSize: 11,
  },
  factGrid: {
    marginTop: 14,
    flexDirection: 'row',
    gap: 8,
  },
  fact: {
    flex: 1,
    padding: 10,
    borderRadius: 10,
    backgroundColor: '#f3f3f3',
  },
  factLabel: {
    color: '#777',
    fontSize: 11,
  },
  factValue: {
    marginTop: 5,
    color: '#222',
    fontSize: 13,
    fontWeight: '700',
  },
  coverage: {
    marginTop: 10,
    color: '#777',
    fontSize: 12,
    lineHeight: 18,
  },
});

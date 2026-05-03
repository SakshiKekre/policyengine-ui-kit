/**
 * UK Parliamentary Constituency Choropleth Map
 *
 * Renders a geographic or hex choropleth map of UK parliamentary constituencies.
 * Geographic view uses British National Grid coordinates with d3-geo geoTransform.
 * Hex view uses axial q/r coordinates from bundled data.
 * Both datasets are bundled — no runtime fetching required.
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { geoPath, geoTransform } from 'd3-geo';
import type {
  ChoroplethDataPoint,
  ChoroplethMapConfig,
  GeoJSONFeature,
  GeoJSONFeatureCollection,
  MapVisualizationType,
  ColorRange,
} from './types';
import {
  calculateColorRange,
  createDataLookupMap,
  getDistrictColor,
  mergeMapConfig,
  hexPoints,
} from './utils';
import { loadUKConstituenciesGeo, loadUKConstituenciesHex } from './data/loaders';
import { PolicyEngineWatermark } from '../display/PolicyEngineWatermark';
import { ZoomControls } from './ZoomControls';
import { MapDownloadButton } from './MapDownloadButton';
import { ColorBar } from './ColorBar';
import { MapTooltip } from './MapTooltip';
import { useSvgZoomPan } from './useSvgZoomPan';
import { useMergedRef } from './useMergedRef';
import { NO_DATA_FILL, MAP_BORDER_COLOR } from './constants';
import { cn } from '../utils/cn';

export interface UKConstituencyChoroplethMapProps {
  /** Array of data points to visualize (geoId = GSS code, e.g. E14001063) */
  data: ChoroplethDataPoint[];
  /** Configuration for the map */
  config?: Partial<ChoroplethMapConfig>;
  /** Map visualization type: 'geographic' or 'hex' */
  visualizationType?: MapVisualizationType;
  /** Optional ref to the map container for image export */
  exportRef?: React.Ref<HTMLDivElement>;
  /** When set, shows a download button that exports the map as an SVG. */
  downloadFilename?: string;
  className?: string;
  styles?: { root?: React.CSSProperties };
}

const BORDER_WIDTH = 0.3;
const SVG_WIDTH = 600;
const DEFAULT_HEIGHT = 700;

// BNG bounding box for UK constituencies
const BNG_X_MIN = -62;
const BNG_X_MAX = 655600;
const BNG_Y_MIN = 7161;
const BNG_Y_MAX = 1218591;

interface TooltipState {
  x: number;
  y: number;
  label: string;
  value: string;
}

/**
 * Build an SVG path string for a BNG GeoJSON feature using an affine transform.
 * BNG coordinates are already projected (eastings/northings in meters), so we
 * apply a simple scale + translate + Y-flip to map them into the SVG viewport.
 */
function useBNGPathGenerator(svgWidth: number, svgHeight: number) {
  return useMemo(() => {
    const padding = 20;
    const drawWidth = svgWidth - padding * 2;
    const drawHeight = svgHeight - padding * 2;

    const bngWidth = BNG_X_MAX - BNG_X_MIN;
    const bngHeight = BNG_Y_MAX - BNG_Y_MIN;

    const scale = Math.min(drawWidth / bngWidth, drawHeight / bngHeight);
    const offsetX = padding + (drawWidth - bngWidth * scale) / 2;
    const offsetY = padding + (drawHeight - bngHeight * scale) / 2;

    const projection = geoTransform({
      point(x: number, y: number) {
        this.stream.point(
          (x - BNG_X_MIN) * scale + offsetX,
          svgHeight - ((y - BNG_Y_MIN) * scale + offsetY),
        );
      },
    });

    return geoPath().projection(projection);
  }, [svgWidth, svgHeight]);
}

type UKConstituencyHex = Record<string, { x: number; y: number; gss: string }>;

/**
 * Convert offset hex grid coordinates (x, y) to pixel positions.
 * Uses the same honeycomb offset as policyengine-app v1:
 * even rows (y % 2 === 0) get x offset by +0.5.
 */
function gridToPixel(
  x: number,
  y: number,
  hexSize: number,
): { cx: number; cy: number } {
  const hexWidth = hexSize * Math.sqrt(3);
  const adjustedX = y % 2 === 0 ? x + 0.5 : x;
  const cx = adjustedX * hexWidth;
  const cy = -y * hexSize * 1.5;
  return { cx, cy };
}

/**
 * Pre-compute hex layout: derive hex size from grid coordinate ranges
 * to fill the SVG viewport, then compute pixel positions.
 */
function useHexLayout(hexData: UKConstituencyHex | null, svgWidth: number, svgHeight: number) {
  return useMemo(() => {
    if (!hexData) return { hexSize: 0, hexagons: [] };
    const entries = Object.entries(hexData);

    // Find grid coordinate ranges
    let gMinX = Infinity, gMaxX = -Infinity, gMinY = Infinity, gMaxY = -Infinity;
    for (const [, { x, y }] of entries) {
      if (x < gMinX) gMinX = x;
      if (x > gMaxX) gMaxX = x;
      if (y < gMinY) gMinY = y;
      if (y > gMaxY) gMaxY = y;
    }

    const gridCols = gMaxX - gMinX + 2; // +2 for hex margin + offset
    const gridRows = gMaxY - gMinY + 2;

    const padding = 20;
    const drawW = svgWidth - padding * 2;
    const drawH = svgHeight - padding * 2;

    // Hex size from available space
    const hexSizeFromWidth = drawW / (gridCols * Math.sqrt(3));
    const hexSizeFromHeight = drawH / (gridRows * 1.5);
    const hexSize = Math.min(hexSizeFromWidth, hexSizeFromHeight);

    // Compute pixel positions with this hex size
    const positions = entries.map(([name, { x, y, gss }]) => {
      const { cx, cy } = gridToPixel(x, y, hexSize);
      return { name, gss, cx, cy };
    });

    // Find pixel bounds to center in viewport
    let fMinX = Infinity, fMaxX = -Infinity, fMinY = Infinity, fMaxY = -Infinity;
    for (const { cx, cy } of positions) {
      if (cx < fMinX) fMinX = cx;
      if (cx > fMaxX) fMaxX = cx;
      if (cy < fMinY) fMinY = cy;
      if (cy > fMaxY) fMaxY = cy;
    }

    const usedW = fMaxX - fMinX;
    const usedH = fMaxY - fMinY;
    const shiftX = padding + (drawW - usedW) / 2 - fMinX;
    const shiftY = padding + (drawH - usedH) / 2 - fMinY;

    return {
      hexSize,
      hexagons: positions.map(({ name, gss, cx, cy }) => ({
        name,
        gss,
        cx: cx + shiftX,
        cy: cy + shiftY,
      })),
    };
  }, [hexData, svgWidth, svgHeight]);
}

export function UKConstituencyChoroplethMap({
  data,
  config,
  visualizationType = 'geographic',
  exportRef,
  downloadFilename,
  className,
  styles,
}: UKConstituencyChoroplethMapProps) {
  const uniqueId = useId();
  const { containerRef, mergedRef } = useMergedRef<HTMLDivElement>(exportRef);
  const isHexMap = visualizationType === 'hex';

  const [geoData, setGeoData] = useState<GeoJSONFeatureCollection | null>(null);
  const [hexData, setHexData] = useState<UKConstituencyHex | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let isMounted = true;

    Promise.all([
      loadUKConstituenciesGeo(),
      loadUKConstituenciesHex(),
    ])
      .then(([geo, hex]) => {
        if (!isMounted) return;
        setGeoData(geo);
        setHexData(hex);
      })
      .catch(() => {
        if (isMounted) setLoadError(true);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const gssToName = useMemo(() => {
    if (!hexData) return new Map<string, string>();
    return new Map(
      Object.entries(hexData).map(([name, { gss }]) => [gss, name]),
    );
  }, [hexData]);

  const fullConfig = useMemo(
    () => mergeMapConfig(config, { width: SVG_WIDTH, height: DEFAULT_HEIGHT, borderWidth: BORDER_WIDTH }),
    [config],
  );
  const dataMap = useMemo(() => createDataLookupMap(data), [data]);

  const colorRange: ColorRange = useMemo(
    () => calculateColorRange(data.map((d) => d.value), fullConfig.colorScale.symmetric ?? true),
    [data, fullConfig.colorScale.symmetric],
  );

  const pathGenerator = useBNGPathGenerator(fullConfig.width, fullConfig.height);
  const hexLayout = useHexLayout(hexData, fullConfig.width, fullConfig.height);

  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const { zoom: svgZoom, pan: svgPan, handlers: zoomHandlers } = useSvgZoomPan();

  const handleMouseEnter = useCallback(
    (event: React.MouseEvent, geoId: string) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const dataPoint = dataMap.get(geoId);
      const name = gssToName.get(geoId) ?? geoId;

      setTooltip({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        label: dataPoint?.label ?? name,
        value: dataPoint ? fullConfig.formatValue(dataPoint.value) : 'No data',
      });
    },
    [dataMap, fullConfig, containerRef, gssToName],
  );

  const handleMouseMove = useCallback(
    (event: React.MouseEvent) => {
      if (!tooltip) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setTooltip((prev) =>
        prev ? { ...prev, x: event.clientX - rect.left, y: event.clientY - rect.top } : null,
      );
    },
    [tooltip, containerRef],
  );

  const handleMouseLeave = useCallback(() => {
    setTooltip(null);
  }, []);

  if (loadError) {
    return (
      <div
        className={cn('flex items-center justify-center', className)}
        style={{ height: fullConfig.height, ...styles?.root }}
      >
        <span className="text-sm text-muted-foreground">Unable to load map data</span>
      </div>
    );
  }

  if (!geoData || !hexData) {
    return (
      <div
        className={cn('flex items-center justify-center', className)}
        style={{ height: fullConfig.height, ...styles?.root }}
      >
        <span className="text-sm text-muted-foreground">Loading map data...</span>
      </div>
    );
  }

  if (!data.length) {
    return (
      <div
        className={cn('flex items-center justify-center', className)}
        style={{ height: fullConfig.height, ...styles?.root }}
      >
        <span className="text-sm text-muted-foreground">No constituency data available</span>
      </div>
    );
  }

  const gradientId = `uk-choropleth-gradient-${uniqueId.replace(/:/g, '')}`;

  return (
    <div
      ref={mergedRef}
      className={cn('flex items-stretch relative bg-white border border-border rounded-lg overflow-hidden', className)}
      style={{ height: fullConfig.height, ...styles?.root }}
    >
      {/* Map */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <svg
          width={fullConfig.width}
          height={fullConfig.height}
          viewBox={`0 0 ${fullConfig.width} ${fullConfig.height}`}
          style={{ width: '100%', height: '100%', cursor: svgZoom > 1 ? 'grab' : 'default' }}
          onWheel={zoomHandlers.onWheel}
          onPointerDown={zoomHandlers.onPointerDown}
          onPointerMove={zoomHandlers.onPointerMove}
          onPointerUp={zoomHandlers.onPointerUp}
        >
          <g transform={`translate(${fullConfig.width / 2}, ${fullConfig.height / 2}) scale(${svgZoom}) translate(${-fullConfig.width / 2 + svgPan[0]}, ${-fullConfig.height / 2 + svgPan[1]})`}>
          {isHexMap
            ? hexLayout.hexagons.map(({ name, gss, cx, cy }) => {
                const dataPoint = dataMap.get(gss);
                const fillColor = dataPoint
                  ? getDistrictColor(dataPoint.value, colorRange, fullConfig.colorScale.colors)
                  : NO_DATA_FILL;

                return (
                  <polygon
                    key={gss}
                    points={hexPoints(cx, cy, hexLayout.hexSize)}
                    fill={fillColor}
                    stroke={MAP_BORDER_COLOR}
                    strokeWidth={0.5}
                    style={{ cursor: 'default', transition: 'opacity 0.15s' }}
                    onMouseEnter={(e) => handleMouseEnter(e, gss)}
                    onMouseMove={handleMouseMove}
                    onMouseLeave={handleMouseLeave}
                  >
                    <title>{name}</title>
                  </polygon>
                );
              })
            : geoData.features.map((feature: GeoJSONFeature) => {
                const gssCode = feature.properties?.DISTRICT_ID as string | undefined;
                const name = feature.properties?.Name as string | undefined;
                const dataPoint = gssCode ? dataMap.get(gssCode) : undefined;
                const fillColor = dataPoint
                  ? getDistrictColor(dataPoint.value, colorRange, fullConfig.colorScale.colors)
                  : NO_DATA_FILL;

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const d = pathGenerator(feature as any) ?? undefined;

                return (
                  <path
                    key={gssCode ?? name}
                    d={d}
                    fill={fillColor}
                    stroke={fullConfig.borderColor}
                    strokeWidth={fullConfig.borderWidth}
                    style={{ cursor: 'default', transition: 'opacity 0.15s' }}
                    onMouseEnter={(e) => {
                      if (gssCode) handleMouseEnter(e, gssCode);
                    }}
                    onMouseMove={handleMouseMove}
                    onMouseLeave={handleMouseLeave}
                  >
                    <title>{name}</title>
                  </path>
                );
              })}
          </g>
        </svg>
      </div>

      {/* Color bar */}
      {fullConfig.showColorBar && (
        <ColorBar
          scaleColors={fullConfig.colorScale.colors}
          height={fullConfig.height}
          min={colorRange.min}
          max={colorRange.max}
          formatValue={fullConfig.formatValue}
          gradientId={gradientId}
        />
      )}

      {/* Tooltip */}
      {tooltip && <MapTooltip {...tooltip} />}

      {/* Zoom controls */}
      <ZoomControls onZoomIn={zoomHandlers.onZoomIn} onZoomOut={zoomHandlers.onZoomOut} onReset={zoomHandlers.onReset} />

      {/* Download button */}
      {downloadFilename && (
        <MapDownloadButton containerRef={containerRef} filename={downloadFilename} />
      )}

      {/* Watermark */}
      <div className="absolute bottom-1 right-2">
        <PolicyEngineWatermark width={160} opacity={0.6} />
      </div>
    </div>
  );
}

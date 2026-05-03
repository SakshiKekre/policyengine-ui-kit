/**
 * US Congressional District Choropleth Map
 *
 * Renders a geographic or hex choropleth map of US congressional districts using
 * d3-geo projections (pure SVG). GeoJSON data is bundled and loaded from
 * lazy chunks when the component mounts.
 * Supports diverging color scales, custom formatting, and state-level zooming.
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { geoPath, geoAlbersUsa, geoEquirectangular } from 'd3-geo';
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
  STATE_ABBREV_TO_FIPS,
  mergeMapConfig,
} from './utils';
import { loadCongressionalDistrictsGeo, loadCongressionalDistrictsHex } from './data/loaders';
import { PolicyEngineWatermark } from '../display/PolicyEngineWatermark';
import { ZoomControls } from './ZoomControls';
import { MapDownloadButton } from './MapDownloadButton';
import { ColorBar } from './ColorBar';
import { MapTooltip } from './MapTooltip';
import { useSvgZoomPan } from './useSvgZoomPan';
import { useMergedRef } from './useMergedRef';
import { NO_DATA_FILL, MAP_BORDER_COLOR } from './constants';
import { cn } from '../utils/cn';

export interface USDistrictChoroplethMapProps {
  /** Array of data points to visualize */
  data: ChoroplethDataPoint[];
  /** Configuration for the map */
  config?: Partial<ChoroplethMapConfig>;
  /** State code to focus/zoom on (e.g., 'CA', 'NY') */
  focusState?: string;
  /** Map visualization type: 'geographic' or 'hex' */
  visualizationType?: MapVisualizationType;
  /** Optional ref to the map container for image export */
  exportRef?: React.Ref<HTMLDivElement>;
  /** State abbreviations whose fetches errored (colored red) */
  errorStates?: string[];
  /** When set, shows a download button that exports the map as an SVG. */
  downloadFilename?: string;
  className?: string;
  styles?: { root?: React.CSSProperties };
}

const BORDER_WIDTH = 0.5;
const SVG_WIDTH = 800;

interface TooltipState {
  x: number;
  y: number;
  label: string;
  value: string;
}

/**
 * Filter features to a specific US state by state abbreviation.
 */
function filterFeaturesByState(
  geoJSON: GeoJSONFeatureCollection,
  focusState: string,
): GeoJSONFeatureCollection {
  const statePrefix = `${focusState.toUpperCase()}-`;
  const fips = STATE_ABBREV_TO_FIPS[focusState.toUpperCase()];

  const filtered = geoJSON.features.filter((f) => {
    const districtId = f.properties?.DISTRICT_ID as string | undefined;
    const stateFp = f.properties?.STATEFP as string | undefined;
    return (districtId && districtId.startsWith(statePrefix)) || (fips && stateFp === fips);
  });

  return { ...geoJSON, features: filtered };
}

/**
 * Build a d3-geo path generator for the given GeoJSON, visualization type, and viewport.
 */
function usePathGenerator(
  geoJSON: GeoJSONFeatureCollection,
  isHex: boolean,
  svgWidth: number,
  svgHeight: number,
) {
  return useMemo(() => {
    const padding = 20;
    const extent: [[number, number], [number, number]] = [
      [padding, padding],
      [svgWidth - padding, svgHeight - padding],
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const collection = geoJSON as any;

    const projection = isHex
      ? geoEquirectangular().fitExtent(extent, collection)
      : geoAlbersUsa().fitExtent(extent, collection);

    return geoPath(projection);
  }, [geoJSON, isHex, svgWidth, svgHeight]);
}

export function USDistrictChoroplethMap({
  data,
  config,
  focusState,
  visualizationType = 'geographic',
  exportRef,
  errorStates,
  downloadFilename,
  className,
  styles,
}: USDistrictChoroplethMapProps) {
  const uniqueId = useId();
  const { containerRef, mergedRef } = useMergedRef<HTMLDivElement>(exportRef);
  const isHexMap = visualizationType === 'hex';

  const [geoData, setGeoData] = useState<Record<MapVisualizationType, GeoJSONFeatureCollection> | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let isMounted = true;

    Promise.all([
      loadCongressionalDistrictsGeo(),
      loadCongressionalDistrictsHex(),
    ])
      .then(([geo, hex]) => {
        if (isMounted) setGeoData({ geographic: geo, hex });
      })
      .catch(() => {
        if (isMounted) setLoadError(true);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const geoJSON = geoData?.[visualizationType] ?? null;
  const fullConfig = useMemo(
    () => mergeMapConfig(config, { width: SVG_WIDTH, height: 500, borderWidth: BORDER_WIDTH }),
    [config],
  );
  const dataMap = useMemo(() => createDataLookupMap(data), [data]);

  const colorRange: ColorRange = useMemo(
    () => calculateColorRange(data.map((d) => d.value), fullConfig.colorScale.symmetric ?? true),
    [data, fullConfig.colorScale.symmetric],
  );

  const errorStateSet = useMemo(
    () => new Set(errorStates?.map((s) => s.toUpperCase()) ?? []),
    [errorStates],
  );

  const emptyCollection: GeoJSONFeatureCollection = useMemo(() => ({ type: 'FeatureCollection', features: [] }), []);

  const displayGeoJSON = useMemo(() => {
    if (!geoJSON) return emptyCollection;
    if (!focusState) return geoJSON;
    return filterFeaturesByState(geoJSON, focusState);
  }, [geoJSON, focusState, emptyCollection]);

  const pathGen = usePathGenerator(displayGeoJSON, isHexMap, SVG_WIDTH, fullConfig.height);

  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const { zoom: svgZoom, pan: svgPan, handlers: zoomHandlers } = useSvgZoomPan();

  const handleMouseEnter = useCallback(
    (event: React.MouseEvent, districtId: string) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const stateAbbr = districtId.split('-')[0]?.toUpperCase();
      if (stateAbbr && errorStateSet.has(stateAbbr)) {
        setTooltip({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
          label: districtId,
          value: 'Error loading data',
        });
        return;
      }

      const dataPoint = dataMap.get(districtId);
      if (!dataPoint) return;

      setTooltip({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        label: dataPoint.label,
        value: fullConfig.formatValue(dataPoint.value),
      });
    },
    [dataMap, fullConfig, errorStateSet, containerRef],
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

  if (!geoData) {
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
        <span className="text-sm text-muted-foreground">No district data available</span>
      </div>
    );
  }

  const gradientId = `choropleth-gradient-${uniqueId.replace(/:/g, '')}`;

  return (
    <div
      ref={mergedRef}
      className={cn('flex items-stretch relative bg-white border border-border rounded-lg overflow-hidden', className)}
      style={{ height: fullConfig.height, ...styles?.root }}
    >
      {/* Map */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <svg
          width={SVG_WIDTH}
          height={fullConfig.height}
          viewBox={`0 0 ${SVG_WIDTH} ${fullConfig.height}`}
          style={{ width: '100%', height: '100%', cursor: svgZoom > 1 ? 'grab' : 'default' }}
          onWheel={zoomHandlers.onWheel}
          onPointerDown={zoomHandlers.onPointerDown}
          onPointerMove={zoomHandlers.onPointerMove}
          onPointerUp={zoomHandlers.onPointerUp}
        >
          <g transform={`translate(${SVG_WIDTH / 2}, ${fullConfig.height / 2}) scale(${svgZoom}) translate(${-SVG_WIDTH / 2 + svgPan[0]}, ${-fullConfig.height / 2 + svgPan[1]})`}>
            {displayGeoJSON.features.map((feature: GeoJSONFeature) => {
              const districtId = feature.properties?.DISTRICT_ID as string | undefined;
              const stateAbbr = districtId?.split('-')[0]?.toUpperCase();
              const isErrorState = stateAbbr ? errorStateSet.has(stateAbbr) : false;
              const dataPoint = districtId ? dataMap.get(districtId) : undefined;

              const fillColor = isErrorState
                ? 'rgba(220, 53, 69, 0.5)'
                : dataPoint
                  ? getDistrictColor(
                      dataPoint.value,
                      colorRange,
                      fullConfig.colorScale.colors,
                    )
                  : NO_DATA_FILL;

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const d = pathGen(feature as any) ?? undefined;

              return (
                <path
                  key={districtId ?? (feature.properties?.GEOID as string)}
                  d={d}
                  fill={fillColor}
                  stroke={MAP_BORDER_COLOR}
                  strokeWidth={BORDER_WIDTH}
                  style={{ cursor: 'default', transition: 'opacity 0.15s' }}
                  onMouseEnter={(e) => {
                    if (districtId) handleMouseEnter(e, districtId);
                  }}
                  onMouseMove={handleMouseMove}
                  onMouseLeave={handleMouseLeave}
                />
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

/**
 * State Legislative District Choropleth Map
 *
 * Renders a geographic choropleth map of state senate or house districts for a
 * single US state using d3-geo projections (pure SVG). GeoJSON data is bundled —
 * no runtime fetching required. Supports diverging color scales, custom formatting,
 * zoom/pan, and SVG download.
 *
 * Only states where average district population >= 100,000 are supported.
 *
 * Source: U.S. Census Bureau, 2024 Cartographic Boundary Files (1:500,000)
 * - Senate: https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_sldu_500k.zip
 * - House:  https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_sldl_500k.zip
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { geoPath, geoAlbersUsa } from 'd3-geo';
import type {
  ChoroplethDataPoint,
  ChoroplethMapConfig,
  GeoJSONFeature,
  GeoJSONFeatureCollection,
  ColorRange,
} from './types';
import {
  calculateColorRange,
  createDataLookupMap,
  getDistrictColor,
  STATE_ABBREV_TO_FIPS,
  isStateQualified,
  mergeMapConfig,
} from './utils';
import type { StateLegislativeChamber } from './utils';
import { loadStateSenateDistrictsGeo, loadStateHouseDistrictsGeo } from './data/loaders';
import { PolicyEngineWatermark } from '../display/PolicyEngineWatermark';
import { ZoomControls } from './ZoomControls';
import { MapDownloadButton } from './MapDownloadButton';
import { ColorBar } from './ColorBar';
import { MapTooltip } from './MapTooltip';
import { useSvgZoomPan } from './useSvgZoomPan';
import { useMergedRef } from './useMergedRef';
import { NO_DATA_FILL, MAP_BORDER_COLOR } from './constants';
import { cn } from '../utils/cn';

export interface StateLegislativeDistrictMapProps {
  /** Array of data points to visualize */
  data: ChoroplethDataPoint[];
  /** Two-letter US state abbreviation (e.g., 'CA', 'NY') */
  state: string;
  /** Which legislative chamber to display */
  chamber: StateLegislativeChamber;
  /** Configuration for the map */
  config?: Partial<ChoroplethMapConfig>;
  /** Optional ref to the map container for image export */
  exportRef?: React.Ref<HTMLDivElement>;
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
 * Filter features to a specific state by FIPS code.
 */
function filterFeaturesByState(
  geoJSON: GeoJSONFeatureCollection,
  stateAbbrev: string,
): GeoJSONFeatureCollection {
  const fips = STATE_ABBREV_TO_FIPS[stateAbbrev.toUpperCase()];
  if (!fips) return { ...geoJSON, features: [] };

  const filtered = geoJSON.features.filter((f) => {
    return f.properties?.STATEFP === fips;
  });

  return { ...geoJSON, features: filtered };
}

/**
 * Build a d3-geo path generator for state-level features.
 */
function usePathGenerator(
  geoJSON: GeoJSONFeatureCollection,
  svgWidth: number,
  svgHeight: number,
) {
  return useMemo(() => {
    if (geoJSON.features.length === 0) return geoPath();

    const padding = 20;
    const extent: [[number, number], [number, number]] = [
      [padding, padding],
      [svgWidth - padding, svgHeight - padding],
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const collection = geoJSON as any;
    const projection = geoAlbersUsa().fitExtent(extent, collection);

    return geoPath(projection);
  }, [geoJSON, svgWidth, svgHeight]);
}

export function StateLegislativeDistrictMap({
  data,
  state,
  chamber,
  config,
  exportRef,
  downloadFilename,
  className,
  styles,
}: StateLegislativeDistrictMapProps) {
  const uniqueId = useId();
  const { containerRef, mergedRef } = useMergedRef<HTMLDivElement>(exportRef);

  const [senateGeo, setSenateGeo] = useState<GeoJSONFeatureCollection | null>(null);
  const [houseGeo, setHouseGeo] = useState<GeoJSONFeatureCollection | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let isMounted = true;

    Promise.all([
      loadStateSenateDistrictsGeo(),
      loadStateHouseDistrictsGeo(),
    ])
      .then(([senate, house]) => {
        if (!isMounted) return;
        setSenateGeo(senate);
        setHouseGeo(house);
      })
      .catch(() => {
        if (isMounted) setLoadError(true);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const fullConfig = useMemo(
    () => mergeMapConfig(config, { width: SVG_WIDTH, height: 500, borderWidth: BORDER_WIDTH }),
    [config],
  );
  const dataMap = useMemo(() => createDataLookupMap(data), [data]);

  const colorRange: ColorRange = useMemo(
    () => calculateColorRange(data.map((d) => d.value), fullConfig.colorScale.symmetric ?? true),
    [data, fullConfig.colorScale.symmetric],
  );

  // Select and filter GeoJSON by chamber + state
  const displayGeoJSON = useMemo(() => {
    const source = chamber === 'upper' ? senateGeo : houseGeo;
    if (!source) return { type: 'FeatureCollection' as const, features: [] as GeoJSONFeature[] };
    return filterFeaturesByState(source, state);
  }, [chamber, state, senateGeo, houseGeo]);

  // Build path generator — fitExtent auto-zooms to the state's features
  const pathGen = usePathGenerator(displayGeoJSON, SVG_WIDTH, fullConfig.height);

  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const { zoom: svgZoom, pan: svgPan, handlers: zoomHandlers } = useSvgZoomPan();

  const handleMouseEnter = useCallback(
    (event: React.MouseEvent, districtId: string) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const dataPoint = dataMap.get(districtId);
      if (!dataPoint) return;

      setTooltip({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        label: dataPoint.label,
        value: fullConfig.formatValue(dataPoint.value),
      });
    },
    [dataMap, fullConfig, containerRef],
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

  if (!senateGeo || !houseGeo) {
    return (
      <div
        className={cn('flex items-center justify-center', className)}
        style={{ height: fullConfig.height, ...styles?.root }}
      >
        <span className="text-sm text-muted-foreground">Loading map data...</span>
      </div>
    );
  }

  // Validation: check if this state/chamber combination is supported
  if (!isStateQualified(state, chamber)) {
    const chamberLabel = chamber === 'upper' ? 'senate' : 'house';
    return (
      <div
        className={cn('flex items-center justify-center', className)}
        style={{ height: fullConfig.height, ...styles?.root }}
      >
        <span className="text-sm text-muted-foreground">
          {state.toUpperCase()} {chamberLabel} districts are not available (average district population is below 100,000)
        </span>
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

  const gradientId = `sld-gradient-${uniqueId.replace(/:/g, '')}`;

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
              const dataPoint = districtId ? dataMap.get(districtId) : undefined;

              const fillColor = dataPoint
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

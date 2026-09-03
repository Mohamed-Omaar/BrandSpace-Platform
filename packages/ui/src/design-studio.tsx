'use client';

import { useState, type ReactNode } from 'react';
import { colorTokens, radiusTokens, shadowTokens, spacingTokens, typographyTokens } from './tokens';
import { Button, ButtonRow, CONTROL_CLASS, IconButton, IconTile, inputStyle } from './primitives';
import { StatusBadge } from './data';
import { PRESET_SIZES } from './studio-presets';
import { AbstractMedia } from './media';
import {
  AlertIcon,
  ImageIcon,
  LayersIcon,
  PaperclipIcon,
  SettingsIcon,
  SparkIcon,
  ShieldIcon,
} from './icons';

/**
 * The Design Studio.
 *
 * A VISUAL AND COMPONENT FOUNDATION, NOT A PRODUCTION EDITOR. The brief is
 * explicit that this is not a Canva clone, and this file is honest about which
 * half it is: the CHROME — toolbar, tool rail, canvas frame, properties panel,
 * preset sizes, layer list — is real, reusable and token-driven, and will carry
 * the production editor when one is built. The CANVAS ITSELF renders a fixed
 * sample composition; selection, drag, zoom and export are not implemented and
 * the surface says so.
 *
 * WHAT IS REUSABLE, precisely, so a later phase does not have to guess:
 *
 *   - `StudioChrome`      — the three-panel layout, responsive behaviour
 *   - `StudioToolRail`    — the tool list with active state and tooltips
 *   - `StudioProperties`  — the properties panel's sections and controls
 *   - `PRESET_SIZES`      — the design sizes, as data
 *
 * WHAT IS A PROTOTYPE: the artboard contents, the zoom value, the save status,
 * the alignment guides, and every control that would mutate a document.
 */

export type StudioTool =
  'templates' | 'uploads' | 'photos' | 'elements' | 'text' | 'brand' | 'background';

export interface StudioLabels {
  readonly designName: string;
  readonly undo: string;
  readonly redo: string;
  readonly zoom: string;
  readonly saved: string;
  readonly preview: string;
  readonly exportAction: string;
  readonly toolsLabel: string;
  readonly toolNames: Record<StudioTool, string>;
  readonly canvasLabel: string;
  readonly propertiesLabel: string;
  readonly sizeLabel: string;
  readonly positionLabel: string;
  readonly colourLabel: string;
  readonly typographyLabel: string;
  readonly alignmentLabel: string;
  readonly layersLabel: string;
  readonly opacityLabel: string;
  readonly effectsLabel: string;
  readonly presetsLabel: string;
  /** The preset design sizes' visible names, keyed by `StudioPreset.id`. */
  readonly presetNames: Record<string, string>;
  readonly prototypeNotice: string;
  readonly layerNames: readonly string[];
  readonly mobileNotice: string;
}

const TOOL_ICONS: Record<StudioTool, ReactNode> = {
  templates: <LayersIcon size={20} />,
  uploads: <PaperclipIcon size={20} />,
  photos: <ImageIcon size={20} />,
  elements: <SparkIcon size={20} />,
  text: (
    <span aria-hidden="true" style={{ fontWeight: 800, fontSize: '1rem' }}>
      T
    </span>
  ),
  brand: <ShieldIcon size={20} />,
  background: <SettingsIcon size={20} />,
};

const TOOLS: readonly StudioTool[] = [
  'templates',
  'uploads',
  'photos',
  'elements',
  'text',
  'brand',
  'background',
];

/** The vertical tool rail. Icon-only with tooltips, like the collapsed sidebar. */
export function StudioToolRail({
  labels,
  active,
  onSelect,
}: {
  readonly labels: StudioLabels;
  readonly active: StudioTool;
  readonly onSelect: (tool: StudioTool) => void;
}) {
  return (
    <nav
      aria-label={labels.toolsLabel}
      data-testid="studio-tool-rail"
      style={{
        display: 'flex',
        flexDirection: 'row',
        gap: spacingTokens.xs,
        padding: spacingTokens.xs,
        borderRadius: radiusTokens.lg,
        background: colorTokens.surfaceSoft,
        overflowX: 'auto',
      }}
      className="bs-studio-rail"
    >
      {TOOLS.map((tool) => {
        const selected = tool === active;
        return (
          <button
            key={tool}
            type="button"
            className="bs-pressable"
            data-testid={`studio-tool-${tool}`}
            aria-pressed={selected}
            onClick={() => onSelect(tool)}
            style={{
              display: 'grid',
              justifyItems: 'center',
              gap: spacingTokens['3xs'],
              minInlineSize: '4rem',
              paddingBlock: spacingTokens.sm,
              paddingInline: spacingTokens.xs,
              borderRadius: radiusTokens.md,
              border: '1px solid transparent',
              cursor: 'pointer',
              fontFamily: 'inherit',
              background: selected ? colorTokens.surfaceLavenderStrong : 'transparent',
              color: selected ? colorTokens.brandPurplePressed : colorTokens.textSecondary,
              ...typographyTokens.caption,
              fontWeight: 600,
            }}
          >
            <span aria-hidden="true" style={{ display: 'inline-flex' }}>
              {TOOL_ICONS[tool]}
            </span>
            {labels.toolNames[tool]}
          </button>
        );
      })}
    </nav>
  );
}

/**
 * The artboard.
 *
 * A REAL COMPOSITION rather than an empty rectangle: a headline, a supporting
 * line, a brand mark and an image block, laid out the way a social graphic
 * actually is. An editor screenshot with a blank canvas tells a reviewer
 * nothing about the product.
 */
function SampleArtboard({ labels }: { readonly labels: StudioLabels }) {
  return (
    <div
      data-testid="studio-artboard"
      role="img"
      aria-label={labels.canvasLabel}
      style={{
        position: 'relative',
        aspectRatio: '1 / 1',
        inlineSize: 'min(100%, 26rem)',
        borderRadius: radiusTokens.sm,
        overflow: 'hidden',
        background: colorTokens.surface,
        boxShadow: shadowTokens.raised,
      }}
    >
      <div style={{ position: 'absolute', inset: 0 }}>
        <AbstractMedia seed={5} alt="" />
      </div>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'grid',
          gridTemplateRows: 'auto 1fr auto',
          padding: '10%',
          gap: '6%',
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: spacingTokens.xs,
            ...typographyTokens.caption,
            fontWeight: 700,
            color: colorTokens.brandPurplePressed,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              inlineSize: '1.25rem',
              blockSize: '1.25rem',
              borderRadius: radiusTokens.xs,
              background: colorTokens.brandPurple,
              color: colorTokens.brandPurpleInk,
              display: 'inline-grid',
              placeItems: 'center',
              fontSize: '0.625rem',
            }}
          >
            B
          </span>
          BrandSpace
        </span>

        <div style={{ display: 'grid', alignContent: 'center', gap: '4%' }}>
          <span
            style={{
              fontSize: 'clamp(1.5rem, 7cqw, 2.5rem)',
              lineHeight: 1.1,
              fontWeight: 800,
              letterSpacing: '-0.03em',
              color: colorTokens.surfaceInk,
            }}
          >
            Plan a whole quarter
            <br />
            in one afternoon
          </span>
          <span
            style={{
              ...typographyTokens.bodySm,
              color: colorTokens.surfaceInk,
              opacity: 0.75,
              maxInlineSize: '22ch',
            }}
          >
            Brand voice, approvals and scheduling in one place.
          </span>
        </div>

        <span
          style={{
            justifySelf: 'start',
            paddingInline: spacingTokens.md,
            paddingBlock: spacingTokens.xs,
            borderRadius: radiusTokens.full,
            background: colorTokens.brandYellow,
            color: colorTokens.brandYellowInk,
            ...typographyTokens.caption,
            fontWeight: 800,
          }}
        >
          brandspace.cc
        </span>
      </div>

      {/* Selection frame and alignment guides — the visual treatment, drawn
          statically. Nothing here is draggable in this phase. */}
      <span
        aria-hidden="true"
        data-testid="studio-selection"
        style={{
          position: 'absolute',
          insetInlineStart: '9%',
          insetBlockStart: '36%',
          inlineSize: '82%',
          blockSize: '30%',
          border: `1.5px solid ${colorTokens.brandPurple}`,
          borderRadius: '2px',
        }}
      >
        {['start start', 'start end', 'end start', 'end end'].map((corner) => {
          const [block, inline] = corner.split(' ') as ['start' | 'end', 'start' | 'end'];
          return (
            <span
              key={corner}
              style={{
                position: 'absolute',
                [block === 'start' ? 'insetBlockStart' : 'insetBlockEnd']: '-4px',
                [inline === 'start' ? 'insetInlineStart' : 'insetInlineEnd']: '-4px',
                inlineSize: '7px',
                blockSize: '7px',
                borderRadius: '2px',
                background: colorTokens.surface,
                border: `1.5px solid ${colorTokens.brandPurple}`,
              }}
            />
          );
        })}
      </span>
      <span
        aria-hidden="true"
        data-testid="studio-guide"
        style={{
          position: 'absolute',
          insetInlineStart: '50%',
          insetBlock: 0,
          inlineSize: '1px',
          background: colorTokens.brandYellow,
          opacity: 0.9,
        }}
      />
    </div>
  );
}

/** The properties panel. Sections by heading, controls with no outlines. */
export function StudioProperties({ labels }: { readonly labels: StudioLabels }) {
  const section = (title: string, children: ReactNode) => (
    <div style={{ display: 'grid', gap: spacingTokens.xs }}>
      <h3
        style={{
          ...typographyTokens.overline,
          textTransform: 'uppercase',
          color: colorTokens.textMuted,
        }}
      >
        {title}
      </h3>
      {children}
    </div>
  );

  const pair = (a: string, b: string) => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: spacingTokens.xs }}>
      <input
        aria-label={a}
        className={CONTROL_CLASS}
        defaultValue={a}
        style={inputStyle({ size: 'sm' })}
      />
      <input
        aria-label={b}
        className={CONTROL_CLASS}
        defaultValue={b}
        style={inputStyle({ size: 'sm' })}
      />
    </div>
  );

  return (
    <aside
      aria-label={labels.propertiesLabel}
      data-testid="studio-properties"
      style={{
        display: 'grid',
        gap: spacingTokens.lg,
        alignContent: 'start',
        padding: spacingTokens.md,
        borderRadius: radiusTokens.xl,
        background: colorTokens.surfaceSoft,
        minInlineSize: 0,
      }}
    >
      {section(labels.sizeLabel, pair('1080', '1080'))}
      {section(labels.positionLabel, pair('96', '388'))}
      {section(
        labels.colourLabel,
        <div style={{ display: 'flex', gap: spacingTokens.xs, flexWrap: 'wrap' }}>
          {[
            colorTokens.brandPurple,
            colorTokens.brandYellow,
            colorTokens.surfaceInk,
            colorTokens.surface,
          ].map((colour) => (
            <span
              key={colour}
              aria-hidden="true"
              style={{
                inlineSize: '1.75rem',
                blockSize: '1.75rem',
                borderRadius: radiusTokens.sm,
                background: colour,
                boxShadow: `inset 0 0 0 1px ${colorTokens.hairline}`,
              }}
            />
          ))}
        </div>,
      )}
      {section(
        labels.typographyLabel,
        <select
          aria-label={labels.typographyLabel}
          className={CONTROL_CLASS}
          style={inputStyle({ size: 'sm' })}
        >
          <option>Inter · Bold · 64</option>
          <option>Cairo · Bold · 64</option>
        </select>,
      )}
      {section(
        labels.alignmentLabel,
        <ButtonRow gap={spacingTokens['3xs']}>
          {['⌐', '≡', '¬'].map((glyph, index) => (
            <IconButton
              key={glyph}
              label={`${labels.alignmentLabel} ${index + 1}`}
              variant="neutral"
              size="sm"
              icon={<span aria-hidden="true">{glyph}</span>}
            />
          ))}
        </ButtonRow>,
      )}
      {section(
        labels.opacityLabel,
        <input
          type="range"
          aria-label={labels.opacityLabel}
          defaultValue={100}
          style={{ inlineSize: '100%', accentColor: colorTokens.brandPurple }}
        />,
      )}
      {section(
        labels.layersLabel,
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'grid',
            gap: spacingTokens['3xs'],
          }}
        >
          {labels.layerNames.map((layer, index) => (
            <li
              key={layer}
              className="bs-row"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: spacingTokens.xs,
                padding: spacingTokens.xs,
                borderRadius: radiusTokens.sm,
                background: index === 1 ? colorTokens.surfaceLavenderStrong : colorTokens.surface,
                ...typographyTokens.caption,
                color: index === 1 ? colorTokens.brandPurplePressed : colorTokens.textSecondary,
                fontWeight: index === 1 ? 700 : 500,
              }}
            >
              <LayersIcon size={14} />
              {layer}
            </li>
          ))}
        </ul>,
      )}
      {section(
        labels.effectsLabel,
        <ButtonRow gap={spacingTokens.xs}>
          <Button variant="neutral" size="sm">
            Shadow
          </Button>
          <Button variant="neutral" size="sm">
            Blur
          </Button>
        </ButtonRow>,
      )}
    </aside>
  );
}

export function DesignStudio({
  labels,
  documentName,
  copilot,
  testId,
}: {
  readonly labels: StudioLabels;
  /** The open design's name. A prop for the same reason as the composer's caption. */
  readonly documentName: string;
  readonly copilot?: ReactNode;
  readonly testId?: string | undefined;
}) {
  const [tool, setTool] = useState<StudioTool>('templates');
  const [preset, setPreset] = useState(PRESET_SIZES[0]!.id);

  return (
    <section
      data-testid={testId ?? 'design-studio'}
      style={{
        display: 'grid',
        gap: spacingTokens.md,
        borderRadius: radiusTokens['2xl'],
        background: colorTokens.surface,
        boxShadow: shadowTokens.card,
        padding: spacingTokens.md,
      }}
    >
      {/* ---------------------------------------------------- Toolbar --- */}
      <header
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: spacingTokens.sm,
        }}
      >
        <IconTile icon={<SparkIcon size={16} />} size="sm" />
        <input
          aria-label={labels.designName}
          className={CONTROL_CLASS}
          data-testid="studio-name"
          defaultValue={documentName}
          style={{ ...inputStyle({ size: 'sm' }), inlineSize: 'auto', maxInlineSize: '14rem' }}
        />
        <StatusBadge label={labels.saved} tone="success" dot testId="studio-save-status" />

        <ButtonRow gap={spacingTokens['3xs']}>
          <IconButton
            label={labels.undo}
            variant="neutral"
            size="sm"
            icon={<span aria-hidden="true">↺</span>}
            data-testid="studio-undo"
          />
          <IconButton
            label={labels.redo}
            variant="neutral"
            size="sm"
            icon={<span aria-hidden="true">↻</span>}
            data-testid="studio-redo"
          />
        </ButtonRow>

        <span
          data-testid="studio-zoom"
          style={{
            paddingInline: spacingTokens.sm,
            paddingBlock: spacingTokens['3xs'],
            borderRadius: radiusTokens.full,
            background: colorTokens.controlSurface,
            ...typographyTokens.caption,
            fontWeight: 600,
            color: colorTokens.textSecondary,
          }}
        >
          {labels.zoom} 72%
        </span>

        <ButtonRow gap={spacingTokens.xs} align="end">
          <Button variant="neutral" size="sm" data-testid="studio-preview">
            {labels.preview}
          </Button>
          <Button variant="primary" size="sm" data-testid="studio-export">
            {labels.exportAction}
          </Button>
        </ButtonRow>
      </header>

      {/*
        THE THREE PANELS. Rail, canvas and properties are siblings in one grid
        so the desktop layout is a real three-column editor, while the same
        markup stacks on a phone rather than being squeezed sideways.
      */}
      <div className="bs-studio-shell" style={{ display: 'grid', gap: spacingTokens.md }}>
        <StudioToolRail labels={labels} active={tool} onSelect={setTool} />

        {/* ---------------------------------------- Canvas + properties --- */}
        <div
          className="bs-studio-body"
          style={{
            display: 'grid',
            gap: spacingTokens.md,
            alignItems: 'start',
          }}
        >
          <div
            data-testid="studio-canvas"
            style={{
              display: 'grid',
              justifyItems: 'center',
              gap: spacingTokens.sm,
              padding: spacingTokens.lg,
              borderRadius: radiusTokens.xl,
              // A controlled dark canvas ground, so the artboard reads as a
              // document on a work surface rather than as another white card.
              background: colorTokens.surfaceInk,
              containerType: 'inline-size',
            }}
          >
            <SampleArtboard labels={labels} />
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: spacingTokens.xs,
                justifyContent: 'center',
              }}
            >
              {PRESET_SIZES.map((size) => (
                <button
                  key={size.id}
                  type="button"
                  className="bs-pressable"
                  data-testid={`studio-preset-${size.id}`}
                  aria-pressed={size.id === preset}
                  onClick={() => setPreset(size.id)}
                  style={{
                    minBlockSize: '2rem',
                    paddingInline: spacingTokens.sm,
                    borderRadius: radiusTokens.full,
                    border: '1px solid transparent',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    ...typographyTokens.caption,
                    fontWeight: 600,
                    background:
                      size.id === preset ? colorTokens.brandPurple : 'rgba(255,255,255,0.12)',
                    color: colorTokens.textInverse,
                  }}
                >
                  {labels.presetNames[size.id] ?? size.id}
                </button>
              ))}
            </div>
          </div>

          <StudioProperties labels={labels} />
        </div>
      </div>

      {copilot}

      <p
        data-testid="studio-prototype-notice"
        style={{
          display: 'flex',
          gap: spacingTokens.xs,
          alignItems: 'center',
          margin: 0,
          ...typographyTokens.caption,
          color: colorTokens.textSecondary,
        }}
      >
        <AlertIcon size={14} />
        {labels.prototypeNotice}
      </p>
      <p
        className="bs-narrow-only"
        data-testid="studio-mobile-notice"
        style={{ margin: 0, ...typographyTokens.caption, color: colorTokens.textSecondary }}
      >
        {labels.mobileNotice}
      </p>
    </section>
  );
}

'use client';

import { useCallback, useRef, useState } from 'react';
import { translator, type MessageKey } from '../../../i18n/messages';
import { BrandOrb, type OrbNode } from './brand-orb';
import { BrandChat } from './brand-chat';
import { AreaDrawer } from './area-drawer';

/**
 * The Brand Brain client island.
 *
 * Holds only what has to be interactive — which area is open, whether chat is
 * open, and the pending file drop. Everything it renders was computed on the
 * server from stored state, so nothing here invents a number.
 */

export interface AreaItemData {
  readonly id: string;
  readonly itemKey: string;
  readonly title: string;
  readonly body: string;
  readonly origin: string;
  readonly originLabel: string;
  readonly version: number;
  readonly stale: boolean;
}

export interface AreaCardData {
  readonly area: string;
  readonly label: string;
  readonly description: string;
  readonly status: 'COMPLETE' | 'NEEDS_ATTENTION' | 'IN_PROGRESS' | 'EMPTY';
  readonly statusLabel: string;
  readonly activeItems: number;
  readonly requiredItems: number;
  readonly pendingCandidates: number;
  readonly ratioMilli: number;
  readonly attention: readonly string[];
  readonly items: readonly AreaItemData[];
}

export interface CandidateData {
  readonly id: string;
  readonly area: string;
  readonly itemKey: string;
  readonly title: string;
  readonly body: string;
  readonly confidencePercent: number;
  readonly evidence: readonly string[];
  readonly replacesExisting: boolean;
}

export interface SourceData {
  readonly id: string;
  readonly fileName: string;
  readonly status: string;
  readonly statusLabel: string;
  readonly detail: string;
}

export interface BrandBrainPermissions {
  readonly edit: boolean;
  readonly upload: boolean;
  readonly review: boolean;
  readonly remove: boolean;
  readonly chat: boolean;
}

export function BrandBrainView({
  locale,
  brandId,
  brandName,
  completionPercent,
  totalActiveItems,
  sourceCount,
  orbAreas,
  areas,
  candidates,
  sources,
  retentionDays,
  permissions,
}: {
  locale: string;
  brandId: string;
  brandName: string;
  completionPercent: number;
  totalActiveItems: number;
  sourceCount: number;
  orbAreas: readonly string[];
  areas: readonly AreaCardData[];
  candidates: readonly CandidateData[];
  sources: readonly SourceData[];
  retentionDays: number;
  permissions: BrandBrainPermissions;
}) {
  const t = translator(locale);
  const [openArea, setOpenArea] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatArea, setChatArea] = useState<string | null>(null);
  const uploadRef = useRef<HTMLFormElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const dropAreaRef = useRef<HTMLInputElement | null>(null);

  const byArea = new Map(areas.map((a) => [a.area, a]));

  const nodes: OrbNode[] = orbAreas
    .map((area) => byArea.get(area))
    .filter((area): area is AreaCardData => area !== undefined)
    .map((area) => ({
      area: area.area,
      label: area.label,
      // The real count, in the reader's language. The demo said "12 facts";
      // this says what is actually there.
      detail: `${area.activeItems} ${t('bb.itemsCount')}`,
      status: area.status,
    }));

  const selectArea = useCallback((area: string) => {
    if (area === '__chat__') {
      setChatArea(null);
      setChatOpen(true);
      return;
    }
    setOpenArea(area);
  }, []);

  /**
   * A file dropped on the orb or a node.
   *
   * It does NOT upload silently. The file is placed on the real upload form and
   * the customer confirms — dropping a file is easy to do by accident, and an
   * upload consumes storage, creates review work and is visible to the whole
   * workspace (CLAUDE.md §2.5).
   */
  const onDropFile = useCallback(
    (area: string | null, file: File) => {
      if (!permissions.upload) return;
      const input = fileRef.current;
      const form = uploadRef.current;
      if (!input || !form) return;
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      if (dropAreaRef.current) dropAreaRef.current.value = area ?? '';
      if (area) setOpenArea(area);
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    [permissions.upload],
  );

  const openAreaData = openArea ? (byArea.get(openArea) ?? null) : null;

  return (
    <div style={{ display: 'grid', gap: '18px' }}>
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.15fr) minmax(260px, 0.85fr)',
          gap: '22px',
          padding: '22px',
          borderRadius: '28px',
          background: 'rgba(255,255,255,.86)',
        }}
        data-testid="brand-brain-hero"
      >
        <div style={{ display: 'grid', gap: '14px', minWidth: 0 }}>
          <h2
            style={{
              margin: 0,
              fontSize: 'clamp(2rem, 4.4vw, 3.4rem)',
              lineHeight: 0.95,
              letterSpacing: '-0.055em',
            }}
          >
            {t('bb.heroTitle')}
            <br />
            <strong style={{ color: '#7935FE' }}>{t('bb.heroTitleAccent')}</strong>
          </h2>
          <BrandOrb
            nodes={nodes}
            centerLabel={brandName}
            centerAriaLabel={t('bb.orbOpenChat')}
            hint={t('bb.orbHint')}
            onSelectArea={selectArea}
            onDropFile={onDropFile}
            canUpload={permissions.upload}
          />
        </div>

        <div style={{ display: 'grid', gap: '12px', alignContent: 'start' }}>
          <div
            data-testid="completion-card"
            style={{ padding: '20px', borderRadius: '22px', background: '#111114', color: '#fff' }}
          >
            <small
              style={{
                color: '#AAA',
                fontSize: '0.62rem',
                letterSpacing: '.1em',
                textTransform: 'uppercase',
              }}
            >
              {t('bb.completion')}
            </small>
            <div
              style={{
                display: 'flex',
                alignItems: 'end',
                justifyContent: 'space-between',
                marginTop: 12,
              }}
            >
              <b
                data-testid="completion-percent"
                style={{ fontSize: '2.8rem', letterSpacing: '-.06em' }}
              >
                {completionPercent}%
              </b>
              <span style={{ fontSize: '0.65rem', color: '#B9B9C0' }}>
                {completionPercent >= 70
                  ? t('bb.completionStrong')
                  : completionPercent > 0
                    ? t('bb.completionBuilding')
                    : t('bb.completionEmpty')}
              </span>
            </div>
            <div
              role="progressbar"
              aria-valuenow={completionPercent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={t('bb.completion')}
              style={{
                height: 8,
                background: '#2B2B30',
                borderRadius: 99,
                overflow: 'hidden',
                marginTop: 14,
              }}
            >
              <i
                style={{
                  display: 'block',
                  width: `${completionPercent}%`,
                  height: '100%',
                  background: 'linear-gradient(90deg,#7935FE,#FFDD15)',
                }}
              />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Metric label={t('bb.knowledgeItems')} value={totalActiveItems} testId="metric-items" />
            <Metric label={t('bb.sourceDocuments')} value={sourceCount} testId="metric-sources" />
          </div>

          <div
            data-testid="attention-card"
            style={{ padding: '16px', borderRadius: '18px', background: '#FFF6CF' }}
          >
            <b style={{ fontSize: '0.8rem' }}>{t('bb.attentionTitle')}</b>
            {areas.some((a) => a.attention.length > 0 && a.status !== 'EMPTY') ? (
              <ul
                style={{
                  margin: '8px 0 0',
                  paddingInlineStart: '1.1rem',
                  fontSize: '0.68rem',
                  color: '#5D5641',
                }}
              >
                {areas
                  .filter((a) => a.attention.length > 0 && a.status !== 'EMPTY')
                  .map((a) => (
                    <li key={a.area}>
                      {a.label} — {a.attention.join(' · ')}
                    </li>
                  ))}
              </ul>
            ) : (
              <p style={{ margin: '8px 0 0', fontSize: '0.68rem', color: '#5D5641' }}>
                {t('bb.attentionNone')}
              </p>
            )}
          </div>
        </div>
      </section>

      <div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'end',
            margin: '10px 4px',
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: '1.5rem', letterSpacing: '-.04em' }}>
              {t('bb.areasTitle')}
            </h3>
            <p style={{ margin: 0, color: '#6D6D76', fontSize: '0.72rem' }}>
              {t('bb.areasSubtitle')}
            </p>
          </div>
          <p style={{ margin: 0, color: '#6D6D76', fontSize: '0.68rem' }}>{t('bb.areasHint')}</p>
        </div>

        <div
          data-testid="area-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 230px), 1fr))',
            gap: 12,
          }}
        >
          {areas.map((area) => (
            <button
              key={area.area}
              type="button"
              data-testid={`area-card-${area.area}`}
              onClick={() => setOpenArea(area.area)}
              style={{
                textAlign: 'start',
                border: 0,
                borderRadius: 20,
                padding: 18,
                minHeight: 170,
                background: 'rgba(255,255,255,.9)',
                display: 'flex',
                flexDirection: 'column',
                cursor: 'pointer',
                font: 'inherit',
              }}
            >
              <h4 style={{ margin: '0 0 6px', fontSize: '1rem', letterSpacing: '-.03em' }}>
                {area.label}
              </h4>
              <p style={{ margin: 0, color: '#6D6D76', fontSize: '0.7rem', lineHeight: 1.55 }}>
                {area.description}
              </p>
              <footer
                style={{
                  marginTop: 'auto',
                  paddingTop: 14,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span
                  data-testid={`area-status-${area.area}`}
                  style={{
                    fontSize: '0.6rem',
                    fontWeight: 800,
                    padding: '5px 8px',
                    borderRadius: 99,
                    color:
                      area.status === 'COMPLETE'
                        ? '#2F7D57'
                        : area.status === 'NEEDS_ATTENTION'
                          ? '#7A6800'
                          : '#55555D',
                    background:
                      area.status === 'COMPLETE'
                        ? '#EAF7EF'
                        : area.status === 'NEEDS_ATTENTION'
                          ? '#FFF9DB'
                          : '#F1F1F4',
                  }}
                >
                  {area.statusLabel}
                </span>
                <span style={{ fontSize: '0.6rem', color: '#999' }}>
                  {area.activeItems} {t('bb.itemsCount')}
                  {area.pendingCandidates > 0
                    ? ` · ${area.pendingCandidates} ${t('bb.pendingCount')}`
                    : ''}
                </span>
              </footer>
            </button>
          ))}
        </div>
      </div>

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))',
          gap: 12,
        }}
      >
        <div
          data-testid="intel-card"
          style={{
            padding: 20,
            borderRadius: 22,
            background: 'linear-gradient(145deg,#EEE6FF,#FFF9D7)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: '1.15rem' }}>{t('bb.intelTitle')}</h3>
            <span
              style={{
                padding: '5px 9px',
                borderRadius: 999,
                background: 'rgba(121,53,254,.12)',
                color: '#5F23DA',
                fontSize: '0.6rem',
                fontWeight: 850,
              }}
            >
              {t('bb.intelBadge')}
            </span>
          </div>
          {candidates.length === 0 ? (
            <p style={{ margin: '14px 0 0', color: '#5C5866', fontSize: '0.7rem' }}>
              {t('bb.intelNone')}
            </p>
          ) : (
            <p style={{ margin: '14px 0 0', color: '#5C5866', fontSize: '0.7rem' }}>
              {candidates.length} {t('bb.pendingCount')}
            </p>
          )}
        </div>

        <div
          data-testid="sources-card"
          style={{ padding: 20, borderRadius: 22, background: 'rgba(255,255,255,.9)' }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <h3 style={{ margin: 0, fontSize: '1.15rem' }}>{t('bb.sourcesTitle')}</h3>
          </div>

          {/*
            The real upload form, and the target of a file dropped on the orb.
            It is rendered only when the caller may upload: a control that looks
            live and answers 404 is worse than one that is not there.
          */}
          {permissions.upload ? (
            <form
              ref={uploadRef}
              action="?"
              method="post"
              encType="multipart/form-data"
              data-testid="upload-form"
              style={{ display: 'grid', gap: 8, marginTop: 12 }}
            >
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="brandId" value={brandId} />
              <input type="hidden" name="area" ref={dropAreaRef} defaultValue="" />
              <input
                ref={fileRef}
                type="file"
                name="file"
                required
                data-testid="upload-input"
                aria-label={t('bb.upload')}
                style={{ font: 'inherit', fontSize: '0.7rem' }}
              />
              <button
                type="submit"
                data-testid="upload-submit"
                formAction={uploadFormAction}
                style={{
                  border: 0,
                  borderRadius: 12,
                  padding: '9px 14px',
                  background: '#111114',
                  color: '#fff',
                  fontWeight: 700,
                  fontSize: '0.7rem',
                  cursor: 'pointer',
                  font: 'inherit',
                  justifySelf: 'start',
                }}
              >
                {t('bb.upload')}
              </button>
              <small style={{ color: '#6D6D76', fontSize: '0.6rem' }}>{t('bb.uploadHint')}</small>
            </form>
          ) : null}

          <div style={{ display: 'grid', gap: 8, marginTop: 14 }}>
            {sources.length === 0 ? (
              <p style={{ margin: 0, color: '#6D6D76', fontSize: '0.7rem' }}>
                {t('bb.sourcesNone')}
              </p>
            ) : (
              sources.map((source) => (
                <div
                  key={source.id}
                  data-testid={`source-${source.id}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0,1fr) auto',
                    gap: 10,
                    alignItems: 'center',
                    padding: 10,
                    borderRadius: 14,
                    background: '#F6F6F7',
                  }}
                >
                  <span style={{ minWidth: 0 }}>
                    <b
                      style={{
                        display: 'block',
                        fontSize: '0.68rem',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {source.fileName}
                    </b>
                    <small style={{ color: '#6D6D76', fontSize: '0.6rem' }}>{source.detail}</small>
                  </span>
                  <span
                    style={{
                      fontSize: '0.6rem',
                      fontWeight: 700,
                      color: source.status === 'FAILED' ? '#A3282F' : '#2F7D57',
                    }}
                  >
                    {source.statusLabel}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      {chatOpen ? (
        <div
          style={{
            position: 'fixed',
            insetInlineEnd: 20,
            insetBlockEnd: 20,
            width: 'min(360px, calc(100vw - 40px))',
            zIndex: 30,
          }}
        >
          <BrandChat
            brandId={brandId}
            area={chatArea}
            canChat={permissions.chat}
            initialMessages={[]}
            onClose={() => setChatOpen(false)}
            labels={{
              title: t('bb.chatTitle'),
              subtitle: t('bb.chatSubtitle'),
              placeholder: t('bb.chatPlaceholder'),
              send: t('bb.chatSend'),
              cancel: t('bb.chatCancel'),
              thinking: t('bb.chatThinking'),
              empty: t('bb.chatEmpty'),
              sources: t('bb.chatSources'),
              insufficient: t('bb.chatInsufficient'),
              disclaimer: t('bb.chatDisclaimer'),
              retention: t('bb.chatRetention').replace('{days}', String(retentionDays)),
              expired: t('bb.chatExpired'),
              error: t('bb.chatError'),
              close: t('bb.chatClose'),
            }}
          />
        </div>
      ) : permissions.chat ? (
        <button
          type="button"
          data-testid="chat-open"
          onClick={() => {
            setChatArea(null);
            setChatOpen(true);
          }}
          style={{
            position: 'fixed',
            insetInlineEnd: 20,
            insetBlockEnd: 20,
            zIndex: 30,
            border: 0,
            borderRadius: 16,
            padding: '12px 16px',
            background: '#7935FE',
            color: '#fff',
            fontWeight: 700,
            fontSize: '0.72rem',
            cursor: 'pointer',
            boxShadow: '0 18px 46px rgba(22,16,39,.2)',
            font: 'inherit',
          }}
        >
          {t('bb.chatOpen')}
        </button>
      ) : null}

      <AreaDrawer
        locale={locale}
        brandId={brandId}
        area={openAreaData}
        candidates={candidates.filter((c) => c.area === openArea)}
        permissions={permissions}
        onClose={() => setOpenArea(null)}
        onAskAbout={(area: string) => {
          setChatArea(area);
          setChatOpen(true);
          setOpenArea(null);
        }}
      />
    </div>
  );
}

function Metric({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <div style={{ padding: 16, borderRadius: 18, background: '#fff' }}>
      <small style={{ display: 'block', color: '#6D6D76', fontSize: '0.6rem' }}>{label}</small>
      <b data-testid={testId} style={{ display: 'block', marginTop: 6, fontSize: '1.4rem' }}>
        {value}
      </b>
    </div>
  );
}

/*
 * The upload action is imported lazily by the form's `formAction`, so the
 * client bundle never pulls the server module graph in.
 */
import { uploadSourceAction as uploadFormAction } from './actions';

export type { MessageKey };

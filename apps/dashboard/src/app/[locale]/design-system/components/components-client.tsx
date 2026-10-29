'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import {
  AlertIcon,
  Button,
  ButtonRow,
  CalendarIcon,
  Card,
  Cell,
  ChipListbox,
  Backdrop,
  ConfirmDialog,
  DataTable,
  Dialog,
  DropdownMenu,
  Field,
  HomeIcon,
  IconButton,
  ImageIcon,
  LanguageSwitcher,
  LinkTabs,
  LockIcon,
  MetricCard,
  Row,
  SearchableSelect,
  SearchField,
  SegmentPill,
  SideSheet,
  SparkIcon,
  StateMessage,
  StatusBadge,
  TeamIcon,
  TabPanel,
  Tabs,
  Tooltip,
  buttonClass,
  cardStyle,
  colorTokens,
  inputStyle,
  menuItemStyle,
  radiusTokens,
  spacingTokens,
  textareaStyle,
  tdStyle,
  thStyle,
  typographyTokens,
  type BadgeTone,
  type ButtonVariant,
  type ControlSize,
  type SurfaceTone,
} from '@brandspace/ui';
import { CheckboxRow } from '@/components/checkbox-row';
import { EmptyAction } from '@/components/empty-action';
import { customerTableStyle } from '@/components/customer-styles';
import { GalleryFeatureCard } from '../showcase-client';
import { LONG_AR, LONG_EN, galleryCopy, type Family } from './components-fixtures';

/**
 * The interactive half of the component gallery.
 *
 * A client component only because several of the shared controls take function
 * props (a Tabs `onSelect`, a ChipListbox trigger) or hold their own open state.
 * Nothing here calls a server action, reads a database or spends a credit.
 *
 * EVERY SECTION RENDERS ITS BODY TWICE — once inside `.bsp-frame` (the customer
 * app) and once inside `.bs-gallery-console` (the Control Center) — through a
 * render function that receives the look, so the two copies cannot drift and so
 * an `id` can carry the look and stay unique.
 */

type Look = 'customer' | 'console';

const VARIANTS: readonly ButtonVariant[] = [
  'primary',
  'brand',
  'accent',
  'neutral',
  'ghost',
  'danger',
];
const SIZES: readonly ControlSize[] = ['sm', 'md', 'lg'];
const TONES: readonly BadgeTone[] = ['neutral', 'success', 'warning', 'danger', 'info', 'accent'];

const label: CSSProperties = {
  ...typographyTokens.caption,
  color: colorTokens.textSecondary,
  fontWeight: 700,
  marginBlockEnd: spacingTokens.xs,
};

const group: CSSProperties = { display: 'grid', gap: spacingTokens.sm, minInlineSize: 0 };
const wrapRow: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: spacingTokens.sm,
};

function Group({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div style={group}>
      <div style={label}>{title}</div>
      {children}
    </div>
  );
}

function Section({
  family,
  locale,
  children,
}: {
  readonly family: Family;
  readonly locale: string;
  readonly children: (look: Look) => ReactNode;
}) {
  const copy = galleryCopy(locale);
  const looks: ReadonlyArray<readonly [Look, string, string]> = [
    ['customer', copy.customerLook, 'bsp-frame'],
    ['console', copy.consoleLook, 'bs-gallery-console'],
  ];
  return (
    <section
      id={`gallery-${family}`}
      data-testid={`gallery-${family}`}
      style={{
        marginBlockEnd: spacingTokens.xl,
        padding: spacingTokens.md,
        background: colorTokens.appBackground,
      }}
    >
      <h2 style={{ ...typographyTokens.h2, margin: 0, marginBlockEnd: spacingTokens.md }}>
        {copy.families[family]}
      </h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: spacingTokens.md,
          alignItems: 'start',
        }}
      >
        {looks.map(([look, title, className]) => (
          <div
            key={look}
            data-look={look}
            className={className}
            style={{
              display: 'grid',
              gap: spacingTokens.lg,
              padding: spacingTokens.md,
              background: colorTokens.surface,
              border: `1px solid ${colorTokens.cardBorder}`,
              borderRadius: radiusTokens['2xl'],
              minInlineSize: 0,
              color: colorTokens.textPrimary,
            }}
          >
            <h3 style={{ ...typographyTokens.label, margin: 0 }}>{title}</h3>
            {children(look)}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * A bounded demo box for anything that is `position: fixed` in the product.
 * `transform` makes the box the containing block for fixed descendants, so a
 * real Dialog or SideSheet opened inside it covers THIS box, not the page.
 */
function Stage({
  testId,
  children,
  height = '26rem',
}: {
  readonly testId: string;
  readonly children: ReactNode;
  readonly height?: string;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        position: 'relative',
        transform: 'translateZ(0)',
        overflow: 'hidden',
        blockSize: height,
        borderRadius: radiusTokens.xl,
        border: `1px solid ${colorTokens.cardBorder}`,
        background: colorTokens.surfaceSoft,
        padding: spacingTokens.md,
      }}
    >
      {children}
    </div>
  );
}

export function ComponentsGallery({ locale }: { readonly locale: string }) {
  const ar = locale === 'ar';
  const c = (en: string, arabic: string) => (ar ? arabic : en);
  const long = ar ? LONG_AR : LONG_EN;
  const props = { locale };

  return (
    <>
      <Section family="button" {...props}>
        {(look) => (
          <>
            <Group title={c('Variant by size', 'النوع حسب الحجم')}>
              <div style={{ display: 'grid', gap: spacingTokens.sm }}>
                {VARIANTS.map((variant) => (
                  <div key={variant} style={wrapRow}>
                    {SIZES.map((size) => (
                      <Button key={size} variant={variant} size={size}>
                        {variant} {size}
                      </Button>
                    ))}
                  </div>
                ))}
              </div>
            </Group>
            <Group title={c('Disabled', 'معطّل')}>
              <div style={wrapRow}>
                {VARIANTS.map((variant) => (
                  <Button key={variant} variant={variant} disabled>
                    {variant}
                  </Button>
                ))}
              </div>
            </Group>
            <Group title={c('Loading (busy)', 'قيد التحميل')}>
              <div style={wrapRow}>
                {VARIANTS.map((variant) => (
                  <Button
                    key={variant}
                    variant={variant}
                    loading
                    loadingLabel={c('Working', 'جارٍ العمل')}
                  >
                    {variant}
                  </Button>
                ))}
              </div>
            </Group>
            <Group title={c('Icon start, icon end, icon only, full width', 'أيقونات وعرض كامل')}>
              <div style={wrapRow}>
                <Button icon={<SparkIcon size={16} />}>{c('With icon', 'مع أيقونة')}</Button>
                <Button variant="neutral" iconEnd={<CalendarIcon size={16} />}>
                  {c('Icon at end', 'أيقونة في النهاية')}
                </Button>
                <IconButton
                  label={c('Icon button', 'زر أيقونة')}
                  icon={<SparkIcon size={18} />}
                  variant="neutral"
                />
                <IconButton
                  label={c('Circular icon button', 'زر أيقونة دائري')}
                  icon={<HomeIcon size={18} />}
                  variant="brand"
                  circular
                />
                <IconButton
                  label={c('Disabled icon button', 'زر أيقونة معطّل')}
                  icon={<LockIcon size={18} />}
                  disabled
                />
              </div>
              <Button variant="brand" fullWidth>
                {c('Full width', 'عرض كامل')}
              </Button>
            </Group>
            <Group title={c('Long text (never wraps, clips at the container)', 'نص طويل')}>
              <div style={{ overflow: 'hidden', maxInlineSize: '100%' }}>
                <Button variant="neutral">{long}</Button>
              </div>
            </Group>
            <Group title={c('As a link, and in a button row', 'كرابط وفي صف أزرار')}>
              <ButtonRow>
                <a href={`#gallery-button-${look}`} className={buttonClass('brand', 'md')}>
                  {c('Link styled as button', 'رابط بشكل زر')}
                </a>
                <Button variant="neutral">{c('Cancel', 'إلغاء')}</Button>
                <Button>{c('Save', 'حفظ')}</Button>
              </ButtonRow>
            </Group>
          </>
        )}
      </Section>

      <Section family="input" {...props}>
        {(look) => {
          const id = (name: string) => `in-${name}-${look}`;
          return (
            <>
              <Group title={c('Single line', 'سطر واحد')}>
                <Field label={c('Default', 'افتراضي')} htmlFor={id('default')}>
                  <input
                    id={id('default')}
                    className="bs-control"
                    style={inputStyle()}
                    placeholder={c('Placeholder text', 'نص إرشادي')}
                  />
                </Field>
                <Field label={c('With value', 'بقيمة')} htmlFor={id('value')}>
                  <input
                    id={id('value')}
                    className="bs-control"
                    style={inputStyle()}
                    defaultValue={c('Sample Brand', 'متجر نموذجي')}
                  />
                </Field>
                <Field
                  label={c('Required with hint', 'مطلوب مع تلميح')}
                  htmlFor={id('hint')}
                  hint={c('Shown under the field', 'يظهر أسفل الحقل')}
                  required
                >
                  <input id={id('hint')} className="bs-control" style={inputStyle()} />
                </Field>
                <Field
                  label={c('Optional', 'اختياري')}
                  htmlFor={id('optional')}
                  optionalLabel={c('optional', 'اختياري')}
                >
                  <input id={id('optional')} className="bs-control" style={inputStyle()} />
                </Field>
                <Field label={c('Disabled', 'معطّل')} htmlFor={id('disabled')}>
                  <input
                    id={id('disabled')}
                    className="bs-control"
                    style={inputStyle()}
                    disabled
                    defaultValue={c('Not editable', 'غير قابل للتعديل')}
                  />
                </Field>
                <Field label={c('Read only', 'للقراءة فقط')} htmlFor={id('readonly')}>
                  <input
                    id={id('readonly')}
                    className="bs-control"
                    style={inputStyle()}
                    readOnly
                    defaultValue={c('Read only value', 'قيمة للقراءة فقط')}
                  />
                </Field>
                <Field
                  label={c('Invalid', 'غير صالح')}
                  htmlFor={id('error')}
                  error={c('Enter a valid address', 'أدخل عنوانًا صالحًا')}
                >
                  <input
                    id={id('error')}
                    className="bs-control"
                    style={inputStyle({ tone: 'error' })}
                    aria-invalid="true"
                    defaultValue="not-an-address"
                  />
                </Field>
                <Field
                  label={c('Valid', 'صالح')}
                  htmlFor={id('success')}
                  success={c('Looks good', 'يبدو جيدًا')}
                >
                  <input
                    id={id('success')}
                    className="bs-control"
                    style={inputStyle({ tone: 'success' })}
                    defaultValue="owner@example.test"
                  />
                </Field>
                <Field label={c('Long value', 'قيمة طويلة')} htmlFor={id('long')}>
                  <input
                    id={id('long')}
                    className="bs-control"
                    style={inputStyle()}
                    defaultValue={long}
                  />
                </Field>
                <SearchField
                  id={id('search')}
                  label={c('Search', 'بحث')}
                  placeholder={c('Search posts', 'ابحث في المنشورات')}
                />
              </Group>
              <Group title={c('Multi line', 'متعدد الأسطر')}>
                <Field label={c('Textarea', 'منطقة نص')} htmlFor={id('ta')}>
                  <textarea
                    id={id('ta')}
                    className="bs-control"
                    style={textareaStyle()}
                    placeholder={c('Write something', 'اكتب شيئًا')}
                  />
                </Field>
                <Field label={c('Textarea with long text', 'نص طويل')} htmlFor={id('ta-long')}>
                  <textarea
                    id={id('ta-long')}
                    className="bs-control"
                    style={textareaStyle()}
                    defaultValue={`${long} ${long}`}
                  />
                </Field>
                <Field label={c('Textarea disabled', 'معطّل')} htmlFor={id('ta-disabled')}>
                  <textarea
                    id={id('ta-disabled')}
                    className="bs-control"
                    style={textareaStyle()}
                    disabled
                    defaultValue={c('Not editable', 'غير قابل للتعديل')}
                  />
                </Field>
                <Field
                  label={c('Textarea invalid', 'غير صالح')}
                  htmlFor={id('ta-error')}
                  error={c('This is too short', 'هذا قصير جدًا')}
                >
                  <textarea
                    id={id('ta-error')}
                    className="bs-control"
                    style={textareaStyle({ tone: 'error' })}
                    aria-invalid="true"
                    defaultValue="x"
                  />
                </Field>
              </Group>
            </>
          );
        }}
      </Section>

      <Section family="select" {...props}>
        {(look) => {
          const options = [
            { value: 'a', label: c('Instagram', 'إنستغرام') },
            { value: 'b', label: c('Facebook', 'فيسبوك'), hint: c('Page', 'صفحة') },
            { value: 'c', label: long },
          ];
          return (
            <>
              <Group title={c('Native select', 'قائمة أصلية')}>
                <Field label={c('Default', 'افتراضي')} htmlFor={`sel-default-${look}`}>
                  <select
                    id={`sel-default-${look}`}
                    className="bs-control"
                    style={inputStyle()}
                    defaultValue="b"
                  >
                    {options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={c('Disabled', 'معطّل')} htmlFor={`sel-disabled-${look}`}>
                  <select
                    id={`sel-disabled-${look}`}
                    className="bs-control"
                    style={inputStyle()}
                    disabled
                  >
                    <option>{c('Not available', 'غير متاح')}</option>
                  </select>
                </Field>
                <Field
                  label={c('Invalid', 'غير صالح')}
                  htmlFor={`sel-error-${look}`}
                  error={c('Choose one', 'اختر واحدًا')}
                >
                  <select
                    id={`sel-error-${look}`}
                    className="bs-control"
                    style={inputStyle({ tone: 'error' })}
                    aria-invalid="true"
                  >
                    <option>{c('Select…', 'اختر…')}</option>
                  </select>
                </Field>
                <Field label={c('Long option', 'خيار طويل')} htmlFor={`sel-long-${look}`}>
                  <select
                    id={`sel-long-${look}`}
                    className="bs-control"
                    style={inputStyle()}
                    defaultValue="c"
                  >
                    {options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </Group>
              <Group title="SearchableSelect">
                <SearchableSelect
                  id={`ss-empty-${look}`}
                  name={`ss-empty-${look}`}
                  options={options}
                  placeholder={c('Choose a channel', 'اختر قناة')}
                  noResultsLabel={c('No results', 'لا نتائج')}
                />
                <SearchableSelect
                  id={`ss-value-${look}`}
                  name={`ss-value-${look}`}
                  options={options}
                  defaultValue="b"
                  placeholder={c('Choose a channel', 'اختر قناة')}
                  noResultsLabel={c('No results', 'لا نتائج')}
                />
                <SearchableSelect
                  id={`ss-long-${look}`}
                  name={`ss-long-${look}`}
                  options={options}
                  defaultValue="c"
                  placeholder={c('Choose a channel', 'اختر قناة')}
                  noResultsLabel={c('No results', 'لا نتائج')}
                />
                <SearchableSelect
                  id={`ss-disabled-${look}`}
                  name={`ss-disabled-${look}`}
                  options={options}
                  disabled
                  placeholder={c('Disabled', 'معطّل')}
                  noResultsLabel={c('No results', 'لا نتائج')}
                />
              </Group>
              <Group title="ChipListbox">
                <div style={wrapRow}>
                  <ChipListbox
                    label={c('Campaign', 'الحملة')}
                    value="b"
                    testId={`gallery-chiplist-${look}`}
                    options={options}
                    trigger={(value) => (
                      <span className="bsp-lbx-val">
                        {options.find((o) => o.value === value)?.label}
                      </span>
                    )}
                  />
                  <ChipListbox
                    label={c('Campaign, none chosen', 'الحملة')}
                    value=""
                    testId={`gallery-chiplist-empty-${look}`}
                    options={[{ value: '', label: c('No campaign', 'بلا حملة') }, ...options]}
                    trigger={() => (
                      <span className="bsp-lbx-val">{c('No campaign', 'بلا حملة')}</span>
                    )}
                  />
                </div>
              </Group>
              <Group title="DropdownMenu">
                <div style={wrapRow}>
                  {(['control', 'primary'] as const).map((kind) => (
                    <DropdownMenu
                      key={kind}
                      label={c('Actions', 'إجراءات')}
                      trigger={kind}
                      testId={`gallery-menu-${kind}-${look}`}
                      triggerContent={`${c('Actions', 'إجراءات')} (${kind})`}
                    >
                      <button type="button" role="menuitem" style={menuItemStyle()}>
                        {c('Edit', 'تعديل')}
                      </button>
                      <button type="button" role="menuitem" style={menuItemStyle()}>
                        {long}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        style={{ ...menuItemStyle(), color: colorTokens.danger }}
                      >
                        {c('Delete', 'حذف')}
                      </button>
                    </DropdownMenu>
                  ))}
                </div>
              </Group>
            </>
          );
        }}
      </Section>

      <Section family="checkbox" {...props}>
        {(look) => (
          <>
            <Group title={c('Native checkbox', 'مربع اختيار أصلي')}>
              <div style={wrapRow}>
                <label style={wrapRow}>
                  <input type="checkbox" /> {c('Unchecked', 'غير محدد')}
                </label>
                <label style={wrapRow}>
                  <input type="checkbox" defaultChecked /> {c('Checked', 'محدد')}
                </label>
                <label style={wrapRow}>
                  <input type="checkbox" disabled /> {c('Disabled', 'معطّل')}
                </label>
                <label style={wrapRow}>
                  <input type="checkbox" disabled defaultChecked />{' '}
                  {c('Disabled checked', 'معطّل محدد')}
                </label>
                <label style={wrapRow}>
                  <input
                    type="checkbox"
                    ref={(node) => {
                      if (node) node.indeterminate = true;
                    }}
                  />{' '}
                  {c('Indeterminate', 'غير محسوم')}
                </label>
                <label style={wrapRow}>
                  <input type="checkbox" aria-invalid="true" /> {c('Invalid', 'غير صالح')}
                </label>
              </div>
            </Group>
            <Group title={c('Native radio', 'زر اختيار أصلي')}>
              <div style={wrapRow} role="radiogroup" aria-label={c('Choice', 'اختيار')}>
                <label style={wrapRow}>
                  <input type="radio" name={`r-${look}`} /> {c('Option one', 'الخيار الأول')}
                </label>
                <label style={wrapRow}>
                  <input type="radio" name={`r-${look}`} defaultChecked />{' '}
                  {c('Option two', 'الخيار الثاني')}
                </label>
                <label style={wrapRow}>
                  <input type="radio" name={`r-${look}`} disabled /> {c('Disabled', 'معطّل')}
                </label>
              </div>
            </Group>
            <Group title={c('Radio chips (.bsp-chip .bsp-ai-chip)', 'شرائح اختيار')}>
              <div style={wrapRow} role="radiogroup" aria-label={c('Language', 'اللغة')}>
                {['EN', 'AR'].map((value) => (
                  <label key={value} className="bsp-chip bsp-ai-chip">
                    <input
                      type="radio"
                      name={`chip-${look}`}
                      value={value}
                      defaultChecked={value === 'EN'}
                      className="bsp-ai-radio"
                    />
                    {value === 'EN' ? c('English', 'الإنجليزية') : c('Arabic', 'العربية')}
                  </label>
                ))}
              </div>
            </Group>
            <Group title={c('Switch rows (CheckboxRow)', 'صفوف المفاتيح')}>
              <div>
                <CheckboxRow
                  name={`cb-off-${look}`}
                  label={c('Off', 'متوقف')}
                  checked={false}
                  testId={`gallery-cbrow-off-${look}`}
                />
                <CheckboxRow
                  name={`cb-on-${look}`}
                  label={c('On, with a hint', 'يعمل مع تلميح')}
                  hint={c('The line under the label', 'السطر أسفل التسمية')}
                  checked
                  testId={`gallery-cbrow-on-${look}`}
                />
                <CheckboxRow
                  name={`cb-long-${look}`}
                  label={long}
                  hint={long}
                  checked
                  testId={`gallery-cbrow-long-${look}`}
                />
              </div>
            </Group>
            <Group title={c('Switch (.bsp-tgl, aria-pressed)', 'مفتاح')}>
              <div style={wrapRow}>
                <button
                  type="button"
                  className="bsp-tgl"
                  aria-pressed="false"
                  aria-label={c('Off', 'متوقف')}
                >
                  <span className="bsp-tgl-k" />
                </button>
                <button
                  type="button"
                  className="bsp-tgl"
                  aria-pressed="true"
                  aria-label={c('On', 'يعمل')}
                >
                  <span className="bsp-tgl-k" />
                </button>
                <button
                  type="button"
                  className="bsp-tgl"
                  aria-pressed="true"
                  disabled
                  aria-label={c('On, disabled', 'يعمل ومعطّل')}
                >
                  <span className="bsp-tgl-k" />
                </button>
              </div>
            </Group>
          </>
        )}
      </Section>

      <Section family="card" {...props}>
        {(look) => (
          <>
            <Group title="Card">
              <Card
                title={c('Card title', 'عنوان البطاقة')}
                description={c('A description under the title', 'وصف أسفل العنوان')}
                icon={<SparkIcon size={18} />}
                actions={
                  <Button size="sm" variant="neutral">
                    {c('Action', 'إجراء')}
                  </Button>
                }
                footer={<span>{c('Footer line', 'سطر التذييل')}</span>}
              >
                {c('Card body text.', 'نص محتوى البطاقة.')}
              </Card>
              <div
                style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: spacingTokens.sm }}
              >
                {(['plain', 'soft', 'warm', 'lavender'] as SurfaceTone[]).map((tone) => (
                  <Card key={tone} tone={tone} title={tone}>
                    {long}
                  </Card>
                ))}
                <Card elevated={false} title={c('Flat', 'مسطحة')}>
                  {c('No shadow', 'بلا ظل')}
                </Card>
                <Card padded={false} title={c('Unpadded', 'بلا حشوة')}>
                  {c('No padding', 'بلا حشوة')}
                </Card>
              </div>
              <div style={cardStyle()} data-testid={`gallery-cardstyle-${look}`}>
                cardStyle()
              </div>
            </Group>
            <Group title=".bsp-card / .bsp-xcard">
              <div className="bsp-card" style={{ padding: spacingTokens.md }}>
                .bsp-card — {long}
              </div>
              <div className="bsp-xgrid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <section className="bsp-xcard">
                  <span className="bsp-xicon" aria-hidden="true">
                    <SparkIcon size={18} />
                  </span>
                  <span className="bsp-xtitle">{c('Static card', 'بطاقة ثابتة')}</span>
                  <span className="bsp-xdesc">{c('A description.', 'وصف.')}</span>
                  <div className="bsp-xfoot">
                    <span>{c('Footer', 'تذييل')}</span>
                    <span className="bsp-xstatus">{c('Ready', 'جاهز')}</span>
                  </div>
                </section>
                <a className="bsp-xcard" href={`#gallery-card-${look}`}>
                  <span className="bsp-xicon" aria-hidden="true">
                    <ImageIcon size={18} />
                  </span>
                  <span className="bsp-xtitle bsp-sm">{c('Link card', 'بطاقة رابط')}</span>
                  <span className="bsp-xdesc">{long}</span>
                  <div className="bsp-xfoot">
                    <span>{c('Footer', 'تذييل')}</span>
                    <span className="bsp-xstatus bsp-warn">{c('Pending', 'قيد الانتظار')}</span>
                  </div>
                </a>
              </div>
            </Group>
            <Group title="MetricCard">
              <div
                style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: spacingTokens.sm }}
              >
                <MetricCard
                  label={c('Reach', 'الوصول')}
                  value="12,480"
                  hint={c('last 30 days', 'آخر 30 يومًا')}
                  icon={<TeamIcon size={18} />}
                />
                <MetricCard
                  label={c('Up', 'ارتفاع')}
                  value="1,240"
                  trend={{ direction: 'up', label: '+12%' }}
                  accent
                />
                <MetricCard
                  label={c('Down', 'انخفاض')}
                  value="980"
                  trend={{ direction: 'down', label: '-4%' }}
                  iconTone="danger"
                  icon={<AlertIcon size={18} />}
                />
                <MetricCard
                  label={c('Flat', 'ثابت')}
                  value="540"
                  trend={{ direction: 'flat', label: '0%' }}
                />
                <MetricCard
                  label={c('Unavailable', 'غير متاح')}
                  unavailable
                  unavailableLabel={c('Not available yet', 'غير متاح بعد')}
                />
                <MetricCard label={long} value="7" hint={long} />
              </div>
            </Group>
            <Group title={c('Feature card', 'بطاقة ميزة')}>
              <div style={{ display: 'grid', gap: spacingTokens.sm }}>
                {(['enabled', 'disabled', 'locked', 'coming-soon'] as const).map((state) => (
                  <GalleryFeatureCard
                    key={state}
                    name={state === 'enabled' ? long : c('Feature', 'ميزة')}
                    description={c('What the feature does.', 'ما تفعله الميزة.')}
                    icon={<SparkIcon size={18} />}
                    state={state}
                    labels={{
                      stateLabels: {
                        enabled: c('Enabled', 'مفعّلة'),
                        disabled: c('Disabled', 'معطّلة'),
                        locked: c('Locked', 'مقفلة'),
                        'coming-soon': c('Coming soon', 'قريبًا'),
                      },
                    }}
                    {...(state === 'locked'
                      ? { lockedReason: c('Available on a higher plan', 'متاحة في خطة أعلى') }
                      : {})}
                    {...(state === 'enabled'
                      ? { usage: { label: c('Used', 'المستخدم'), value: '12 / 50' } }
                      : {})}
                    {...(state !== 'coming-soon'
                      ? {
                          action: (
                            <Button size="sm" variant="neutral" disabled={state !== 'enabled'}>
                              {c('Open', 'فتح')}
                            </Button>
                          ),
                        }
                      : {})}
                    testId={`gallery-feature-${state}-${look}`}
                  />
                ))}
              </div>
            </Group>
          </>
        )}
      </Section>

      <Section family="badge" {...props}>
        {() => (
          <>
            <Group title="StatusBadge">
              <div style={wrapRow}>
                {TONES.map((tone) => (
                  <StatusBadge key={tone} tone={tone} label={tone} />
                ))}
              </div>
              <div style={wrapRow}>
                {TONES.map((tone) => (
                  <StatusBadge key={tone} tone={tone} label={tone} dot />
                ))}
              </div>
              <StatusBadge tone="info" label={long} dot />
            </Group>
            <Group title=".bsp-pill">
              <div style={wrapRow}>
                {(['ok', 'info', 'warn', 'bad', 'neu', 'ai'] as const).map((tone) => (
                  <span key={tone} className={`bsp-pill bsp-p-${tone}`}>
                    {tone}
                  </span>
                ))}
              </div>
              <div style={{ overflow: 'hidden' }}>
                <span className="bsp-pill bsp-p-ai">{long}</span>
              </div>
            </Group>
            <Group title=".bsp-xstatus">
              <div style={wrapRow}>
                <span className="bsp-xstatus">ok</span>
                <span className="bsp-xstatus bsp-warn">warn</span>
                <span className="bsp-xstatus bsp-neu">neu</span>
                <span className="bsp-xstatus bsp-ai">ai</span>
                <span className="bsp-xstatus bsp-bad">bad</span>
              </div>
            </Group>
            <Group title=".bsp-chip">
              <div style={wrapRow}>
                <button type="button" className="bsp-chip">
                  {c('Default', 'افتراضي')}
                </button>
                <button type="button" className="bsp-chip" aria-pressed="true">
                  {c('Selected', 'محدد')}
                </button>
                <button type="button" className="bsp-chip" disabled>
                  {c('Disabled', 'معطّل')}
                </button>
                <button
                  type="button"
                  className="bsp-chip"
                  data-unavailable="true"
                  aria-disabled="true"
                >
                  {c('Unavailable', 'غير متاح')}
                </button>
                <button type="button" className="bsp-chip bs-control">
                  {c('With control class', 'بفئة التحكم')}
                </button>
              </div>
              <div style={{ overflow: 'hidden' }}>
                <button type="button" className="bsp-chip">
                  {long}
                </button>
              </div>
            </Group>
          </>
        )}
      </Section>

      <DialogSection {...props} />
      <BackdropSection {...props} />

      <Section family="tooltip" {...props}>
        {(look) => (
          <>
            <Group title="Tooltip">
              <div
                style={{
                  ...wrapRow,
                  minBlockSize: '6rem',
                  alignItems: 'flex-start',
                  gap: spacingTokens.lg,
                }}
              >
                <span data-testid={`gallery-tooltip-${look}`}>
                  <Tooltip label={c('Explains the control', 'يشرح عنصر التحكم')}>
                    <Button variant="neutral">{c('Hover or focus me', 'مرّر أو ركّز')}</Button>
                  </Tooltip>
                </span>
                <Tooltip label={c('Beside', 'بجانبه')} placement="inline-end">
                  <IconButton
                    label={c('Icon with tooltip', 'أيقونة بتلميح')}
                    icon={<SparkIcon size={18} />}
                    variant="neutral"
                  />
                </Tooltip>
                <Tooltip label={long}>
                  <Button variant="ghost">{c('Long tooltip', 'تلميح طويل')}</Button>
                </Tooltip>
              </div>
            </Group>
            <Group title={c('Native title attribute', 'سمة title الأصلية')}>
              <div style={wrapRow}>
                <button
                  type="button"
                  className={buttonClass('neutral', 'md')}
                  title={c('The browser draws this one', 'المتصفح يرسم هذا')}
                >
                  {c('Native title', 'تلميح أصلي')}
                </button>
              </div>
            </Group>
          </>
        )}
      </Section>

      <Section family="table" {...props}>
        {(look) => {
          const rows = [
            { id: '1', name: c('Spring launch', 'إطلاق الربيع'), tone: 'success' as const },
            { id: '2', name: long, tone: 'warning' as const },
            { id: '3', name: c('Holiday push', 'حملة العطلة'), tone: 'neutral' as const },
          ];
          const consoleTable: CSSProperties = {
            inlineSize: '100%',
            borderCollapse: 'collapse',
            fontSize: typographyTokens.bodySm.fontSize,
            textAlign: 'start',
          };
          return (
            <>
              <Group title="DataTable">
                <DataTable
                  headers={[c('Name', 'الاسم'), c('Status', 'الحالة'), c('Owner', 'المالك')]}
                  caption={c('Campaigns', 'الحملات')}
                  minWidth="var(--bsp-rem-24)"
                  testId={`gallery-datatable-${look}`}
                >
                  {rows.map((row, index) => (
                    <Row key={row.id} selected={index === 1}>
                      <Cell>{row.name}</Cell>
                      <Cell>
                        <StatusBadge label={row.tone} tone={row.tone} />
                      </Cell>
                      <Cell>owner@example.test</Cell>
                    </Row>
                  ))}
                </DataTable>
                <DataTable
                  headers={[c('Name', 'الاسم'), c('Status', 'الحالة')]}
                  caption={c('Empty table', 'جدول فارغ')}
                  minWidth="var(--bsp-rem-24)"
                >
                  {null}
                </DataTable>
              </Group>
              <Group title={look === 'customer' ? 'customerTableStyle()' : 'tableStyle()'}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={look === 'customer' ? customerTableStyle() : consoleTable}>
                    <thead>
                      <tr>
                        <th scope="col" style={thStyle()}>
                          {c('Name', 'الاسم')}
                        </th>
                        <th scope="col" style={thStyle()}>
                          {c('Status', 'الحالة')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.id}>
                          <td style={tdStyle()}>{row.name}</td>
                          <td style={tdStyle()}>
                            <StatusBadge label={row.tone} tone={row.tone} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Group>
            </>
          );
        }}
      </Section>

      <Section family="empty" {...props}>
        {(look) => (
          <>
            <Group title="StateMessage">
              <StateMessage
                kind="empty"
                title={c('Nothing here yet', 'لا شيء هنا بعد')}
                description={c('Create the first one to see it here.', 'أنشئ أول عنصر ليظهر هنا.')}
                testId={`gallery-state-empty-${look}`}
                action={
                  <EmptyAction
                    href={`#gallery-empty-${look}`}
                    label={c('Create one', 'إنشاء')}
                    testId={`gallery-empty-action-${look}`}
                  />
                }
              />
              <StateMessage
                kind="no-results"
                title={c('No results', 'لا نتائج')}
                description={long}
                testId={`gallery-state-noresults-${look}`}
              />
              <StateMessage
                kind="error"
                title={c('Something went wrong', 'حدث خطأ ما')}
                description={c('Try again in a moment.', 'حاول مرة أخرى بعد قليل.')}
                testId={`gallery-state-error-${look}`}
                action={
                  <EmptyAction
                    href={`#gallery-empty-${look}`}
                    label={c('Retry', 'إعادة المحاولة')}
                    testId={`gallery-empty-retry-${look}`}
                    tone="neutral"
                  />
                }
              />
              <StateMessage
                kind="forbidden"
                title={c('You do not have access', 'لا تملك صلاحية الوصول')}
                testId={`gallery-state-forbidden-${look}`}
              />
            </Group>
            <Group title=".bsp-*-empty">
              <section className="bsp-xcard bsp-posts-empty">
                <b>{c('No posts here yet', 'لا منشورات هنا بعد')}</b>
                <span className="bsp-xdesc">
                  {c('Posts you create appear here.', 'تظهر هنا المنشورات التي تنشئها.')}
                </span>
              </section>
              <div className="bsp-card bsp-camp-empty">
                <b>{c('No campaigns yet', 'لا حملات بعد')}</b>
                {long}
              </div>
              <div className="bsp-card bsp-med-empty" style={{ padding: spacingTokens.md }}>
                <b>{c('The library is empty', 'المكتبة فارغة')}</b>
                <div className="bsp-med-empty-acts">
                  <Button size="sm" variant="neutral">
                    {c('Upload', 'رفع')}
                  </Button>
                </div>
              </div>
              <div className="bsp-bb-empty">{c('Nothing recorded.', 'لا شيء مسجل.')}</div>
            </Group>
          </>
        )}
      </Section>

      <NavSection {...props} />
    </>
  );
}

/* -------------------------------------------------------------- dialog --- */

function DialogSection({ locale }: { readonly locale: string }) {
  const ar = locale === 'ar';
  const c = (en: string, arabic: string) => (ar ? arabic : en);
  const long = ar ? LONG_AR : LONG_EN;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (key: string, value: boolean) => setOpen((state) => ({ ...state, [key]: value }));
  return (
    <Section family="dialog" locale={locale}>
      {(look) => {
        const key = (name: string) => `${name}-${look}`;
        return (
          <>
            <Group
              title={c(
                'Real components, opened inside a bounded box',
                'مكوّنات حقيقية داخل صندوق محدود',
              )}
            >
              <Stage testId={`gallery-stage-dialog-${look}`}>
                <div style={wrapRow}>
                  <Button
                    variant="neutral"
                    data-testid={`gallery-open-dialog-${look}`}
                    onClick={() => toggle(key('dialog'), true)}
                  >
                    Dialog
                  </Button>
                  <Button
                    variant="neutral"
                    data-testid={`gallery-open-confirm-${look}`}
                    onClick={() => toggle(key('confirm'), true)}
                  >
                    ConfirmDialog
                  </Button>
                  <Button
                    variant="neutral"
                    data-testid={`gallery-open-sheet-${look}`}
                    onClick={() => toggle(key('sheet'), true)}
                  >
                    SideSheet
                  </Button>
                </div>
                <Dialog
                  open={open[key('dialog')] === true}
                  onClose={() => toggle(key('dialog'), false)}
                  title={c('Dialog title', 'عنوان النافذة')}
                  description={c(
                    'A short description of what this asks.',
                    'وصف قصير لما تطلبه النافذة.',
                  )}
                  closeLabel={c('Close', 'إغلاق')}
                  testId={`gallery-dialog-${look}`}
                  footer={
                    <>
                      <Button variant="neutral" onClick={() => toggle(key('dialog'), false)}>
                        {c('Cancel', 'إلغاء')}
                      </Button>
                      <Button onClick={() => toggle(key('dialog'), false)}>
                        {c('Save', 'حفظ')}
                      </Button>
                    </>
                  }
                >
                  <Field label={c('Name', 'الاسم')} htmlFor={`dialog-name-${look}`}>
                    <input
                      id={`dialog-name-${look}`}
                      className="bs-control"
                      style={inputStyle()}
                      defaultValue={long}
                    />
                  </Field>
                </Dialog>
                <ConfirmDialog
                  open={open[key('confirm')] === true}
                  onClose={() => toggle(key('confirm'), false)}
                  onConfirm={() => toggle(key('confirm'), false)}
                  title={c('Delete this?', 'حذف هذا؟')}
                  description={c('This cannot be undone.', 'لا يمكن التراجع عن هذا.')}
                  confirmLabel={c('Delete', 'حذف')}
                  cancelLabel={c('Cancel', 'إلغاء')}
                  closeLabel={c('Close', 'إغلاق')}
                  testId={`gallery-confirm-${look}`}
                />
                <SideSheet
                  open={open[key('sheet')] === true}
                  onClose={() => toggle(key('sheet'), false)}
                  title={c('Side sheet', 'لوحة جانبية')}
                  description={c('Details open beside the page.', 'تفاصيل تُفتح بجانب الصفحة.')}
                  closeLabel={c('Close', 'إغلاق')}
                  testId={`gallery-sheet-${look}`}
                >
                  <p style={{ ...typographyTokens.body, margin: 0 }}>{long}</p>
                </SideSheet>
              </Stage>
            </Group>
          </>
        );
      }}
    </Section>
  );
}

/* ------------------------------------------------------------ backdrop --- */

/**
 * THE ONE BACKDROP (S5, D-5): every drawer, sheet and dialog sits on `Backdrop`
 * — one tint (`--bs-scrim`), one blur (`--bs-fx-backdrop-scrim`), the token
 * z-index. Each group is a real user of it:
 *
 *   - the SideSheet (layer `drawer`; also the navigation and post drawers);
 *   - the Dialog (layer `dialog`, with the MO6 fade);
 *   - the rule-builder and campaign veils (`.bsp-au-veil`, `.bsp-cp-veil`:
 *     their classes now only centre the card);
 *   - the Copilot phone sheet's scrim (layer `overlay`; `.bs-copilot-scrim`
 *     only decides WHEN it shows: `display: none` from 768px up).
 *
 * The first two are opened from a button because the shared components own
 * their backdrop; the box is the containing block (see `Stage`).
 */
function BackdropSection({ locale }: { readonly locale: string }) {
  const ar = locale === 'ar';
  const c = (en: string, arabic: string) => (ar ? arabic : en);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (key: string, value: boolean) => setOpen((state) => ({ ...state, [key]: value }));
  return (
    <Section family="backdrop" locale={locale}>
      {(look) => {
        const key = (name: string) => `bd-${name}-${look}`;
        const behind = (
          <div style={{ display: 'grid', gap: spacingTokens.xs }}>
            <strong>{c('Page content behind the backdrop', 'محتوى الصفحة خلف الخلفية')}</strong>
            <span>
              {c(
                'Lines of text to show how much shows through.',
                'أسطر نصية لإظهار ما يظهر من خلفها.',
              )}
            </span>
          </div>
        );
        return (
          <>
            <Group title={c('Backdrop · drawer (SideSheet)', 'الخلفية · لوحة جانبية')}>
              <Stage testId={`gallery-backdrop-sheet-${look}`} height="12rem">
                {behind}
                <Button
                  variant="neutral"
                  size="sm"
                  data-testid={`gallery-open-bd-sheet-${look}`}
                  onClick={() => toggle(key('sheet'), true)}
                >
                  {c('Open', 'فتح')}
                </Button>
                <SideSheet
                  open={open[key('sheet')] === true}
                  onClose={() => toggle(key('sheet'), false)}
                  title={c('Side sheet', 'لوحة جانبية')}
                  closeLabel={c('Close', 'إغلاق')}
                  testId={`gallery-bd-sheet-${look}`}
                />
              </Stage>
            </Group>
            <Group
              title={c(
                'Backdrop · dialog, with its fade (Dialog)',
                'الخلفية · نافذة مع ظهورها التدريجي',
              )}
            >
              <Stage testId={`gallery-backdrop-dialog-${look}`} height="12rem">
                {behind}
                <Button
                  variant="neutral"
                  size="sm"
                  data-testid={`gallery-open-bd-dialog-${look}`}
                  onClick={() => toggle(key('dialog'), true)}
                >
                  {c('Open', 'فتح')}
                </Button>
                <Dialog
                  open={open[key('dialog')] === true}
                  onClose={() => toggle(key('dialog'), false)}
                  title={c('Dialog', 'نافذة')}
                  closeLabel={c('Close', 'إغلاق')}
                  testId={`gallery-bd-dialog-${look}`}
                />
              </Stage>
            </Group>
            <Group
              title={c(
                'Backdrop · the rule and campaign veils',
                'الخلفية · نافذتا القاعدة والحملة',
              )}
            >
              <Stage testId={`gallery-backdrop-veil28-${look}`} height="12rem">
                {behind}
                <Backdrop layer="dialog" className="bsp-au-veil">
                  <div
                    className="bsp-card"
                    style={{ padding: spacingTokens.md, maxInlineSize: '70%' }}
                  >
                    {c('Rule builder card', 'بطاقة منشئ القاعدة')}
                  </div>
                </Backdrop>
              </Stage>
              <Stage testId={`gallery-backdrop-cpveil-${look}`} height="12rem">
                {behind}
                <Backdrop layer="dialog" className="bsp-cp-veil">
                  <div
                    className="bsp-card"
                    style={{ padding: spacingTokens.md, maxInlineSize: '70%' }}
                  >
                    {c('Campaign dialog card', 'بطاقة نافذة الحملة')}
                  </div>
                </Backdrop>
              </Stage>
            </Group>
            <Group
              title={c(
                'Backdrop · overlay (Copilot phone sheet)',
                'الخلفية · طبقة المساعد على الهاتف',
              )}
            >
              <Stage testId={`gallery-backdrop-classes-${look}`} height="12rem">
                {behind}
                <Backdrop layer="overlay" className="bs-copilot-scrim" />
              </Stage>
            </Group>
          </>
        );
      }}
    </Section>
  );
}

/* ------------------------------------------------------------------ nav --- */

function NavSection({ locale }: { readonly locale: string }) {
  const ar = locale === 'ar';
  const c = (en: string, arabic: string) => (ar ? arabic : en);
  const long = ar ? LONG_AR : LONG_EN;
  const other = ar ? 'en' : 'ar';
  const [tab, setTab] = useState('one');
  const [pressed, setPressed] = useState('week');
  return (
    <Section family="nav" locale={locale}>
      {(look) => {
        const tabs = [
          {
            id: `one-${look}`,
            href: `#gallery-nav-one-${look}`,
            label: c('Overview', 'نظرة عامة'),
          },
          {
            id: 'two',
            href: `#gallery-nav-two-${look}`,
            label: c('Members', 'الأعضاء'),
            badge: '3',
          },
          { id: `three-${look}`, href: `#gallery-nav-three-${look}`, label: long },
        ];
        const panelTabs = tabs.map(({ id, label: tabLabel }) => ({ id, label: tabLabel }));
        return (
          <>
            <Group title={c('Sidebar items (.bsp-sbnav .bsp-nav)', 'عناصر الشريط الجانبي')}>
              <nav
                className="bsp-sbnav"
                aria-label={c('Sidebar', 'الشريط الجانبي')}
                style={{ overflow: 'visible' }}
              >
                <a className="bsp-nav" href={`#gallery-nav-${look}`} aria-current="page">
                  <HomeIcon size={18} />
                  {c('Current item', 'العنصر الحالي')}
                </a>
                <a className="bsp-nav" href={`#gallery-nav-${look}`}>
                  <CalendarIcon size={18} />
                  {c('Other item', 'عنصر آخر')}
                  <span className="bsp-cnt" data-tone="ink" aria-hidden="true">
                    4
                  </span>
                </a>
                <a className="bsp-nav" href={`#gallery-nav-${look}`}>
                  <TeamIcon size={18} />
                  {long}
                </a>
              </nav>
            </Group>
            <Group title="LinkTabs">
              <LinkTabs
                label={c('Prototype look', 'المظهر الأصلي')}
                tabs={tabs}
                currentId={`two-${look}`}
                testId={`gallery-linktabs-proto-${look}`}
              />
              <LinkTabs
                label={c('Console look', 'مظهر المركز')}
                tabs={tabs}
                currentId={`two-${look}`}
                look="console"
                testId={`gallery-linktabs-console-${look}`}
              />
            </Group>
            <Group title="Tabs">
              <Tabs
                label={c('Sections', 'الأقسام')}
                tabs={panelTabs}
                activeId={`${tab}-${look}`}
                onSelect={(id) => setTab(id.replace(/-(customer|console)$/, ''))}
                testId={`gallery-tabs-${look}`}
              />
              {panelTabs.map((item) => (
                <TabPanel key={item.id} id={item.id} activeId={`${tab}-${look}`}>
                  <span>{item.label}</span>
                </TabPanel>
              ))}
            </Group>
            <Group title={c('Segment pill (.bsp-seg)', 'شريحة التبديل')}>
              <div className="bsp-seg" data-testid={`gallery-seg-${look}`}>
                <SegmentPill selector='[aria-pressed="true"]' />
                {['day', 'week', 'month'].map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="bsp-seg-item"
                    aria-pressed={pressed === value}
                    onClick={() => setPressed(value)}
                  >
                    {value === 'day'
                      ? c('Day', 'يوم')
                      : value === 'week'
                        ? c('Week', 'أسبوع')
                        : c('Month', 'شهر')}
                  </button>
                ))}
                <button type="button" className="bsp-seg-item" disabled>
                  {c('Disabled', 'معطّل')}
                </button>
              </div>
            </Group>
            <Group title={c('Language switchers', 'مبدّلات اللغة')}>
              <div style={wrapRow}>
                <LanguageSwitcher
                  href={`/${other}/design-system/components`}
                  targetLocale={other}
                  targetLabel={other === 'ar' ? 'العربية' : 'English'}
                  ariaLabel={c('Change language', 'تغيير اللغة')}
                />
                <a
                  href={`/${other}/design-system/components`}
                  hrefLang={other}
                  lang={other}
                  aria-label={c('Change language (prototype rail)', 'تغيير اللغة')}
                  className="bsp-ibtn bsp-lang"
                >
                  {other === 'ar' ? 'ع' : 'EN'}
                </a>
              </div>
            </Group>
          </>
        );
      }}
    </Section>
  );
}

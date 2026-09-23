import type { EmailMessageInput, EmailTemplateKey } from './email';

/**
 * The words a real provider actually sends.
 *
 * WHY THIS FILE DID NOT EXIST BEFORE. The outbox stores a template KEY and its
 * variables and delivers nothing, so until a provider could send, nothing ever
 * needed a subject line. `ResendEmailProvider` does, and inventing one at the
 * call site would put six half-written English sentences in six unrelated
 * files.
 *
 * BOTH LANGUAGES, BECAUSE THE RECIPIENT IS NOT IN THE PRODUCT. Every other
 * string in BrandSpace is resolved from the reader's own locale at render time.
 * An email is read in an inbox, where there is no session and no preference to
 * read — so the locale travels ON the message, chosen when it was created, and
 * the renderer has to hold both. A single-language catalogue here would make
 * every Arabic customer's verification link arrive in English.
 *
 * BRANDED, BUT STILL TRANSACTIONAL. These messages use one restrained
 * BrandSpace shell: no tracking pixel, no marketing content and no unsubscribe
 * footer. The shell is intentionally table-based with inline styles so it
 * survives conservative email clients while the security-sensitive words and
 * links remain owned by this closed catalogue.
 *
 * THE TOKEN IS NEVER A VARIABLE. `link` is handed in already composed and is
 * never persisted; the templates below interpolate it and nothing else that
 * could identify an account.
 */

export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

interface TemplateCopy {
  readonly subject: string;
  /** The sentence before the link. */
  readonly body: string;
  /** The label on the link, when the template has one. */
  readonly action?: string;
}

type LocalisedTemplate = { readonly AR: TemplateCopy; readonly EN: TemplateCopy };

const TEMPLATES: Readonly<Record<EmailTemplateKey, LocalisedTemplate>> = {
  'auth.email_verification': {
    EN: {
      subject: 'Confirm your BrandSpace email address',
      body: 'Confirm this address to finish creating your BrandSpace account. If you did not ask for this, ignore this message.',
      action: 'Confirm my email address',
    },
    AR: {
      subject: 'أكّد بريدك الإلكتروني في BrandSpace',
      body: 'أكّد هذا العنوان لإتمام إنشاء حسابك في BrandSpace. إن لم تطلب ذلك، تجاهل هذه الرسالة.',
      action: 'تأكيد بريدي الإلكتروني',
    },
  },
  /*
   * THE PAIR THAT MAKES ADDRESS ENUMERATION USELESS (§10). A free address gets
   * a verification link; a taken one gets this. The two are indistinguishable
   * to the person who triggered them, so they have to LOOK alike from outside:
   * the same channel, the same sender, the same timing. Only the recipient can
   * tell which arrived.
   */
  'auth.signup.exists': {
    EN: {
      subject: 'Confirm your BrandSpace email address',
      body: 'Someone tried to create a BrandSpace account with this address, and one already exists. If that was you, sign in instead. If it was not, no action is needed.',
      action: 'Sign in',
    },
    AR: {
      subject: 'أكّد بريدك الإلكتروني في BrandSpace',
      body: 'حاول أحدهم إنشاء حساب في BrandSpace بهذا العنوان، وهناك حساب قائم بالفعل. إن كنت أنت، سجّل الدخول. وإن لم تكن، فلا يلزم أي إجراء.',
      action: 'تسجيل الدخول',
    },
  },
  'auth.password_reset': {
    EN: {
      subject: 'Reset your BrandSpace password',
      body: 'Use the link below to choose a new password. It expires shortly, and can be used once. If you did not ask for this, your password has not changed and no action is needed.',
      action: 'Choose a new password',
    },
    AR: {
      subject: 'إعادة تعيين كلمة مرور BrandSpace',
      body: 'استخدم الرابط أدناه لاختيار كلمة مرور جديدة. تنتهي صلاحيته قريبًا ويُستخدم مرة واحدة. إن لم تطلب ذلك، فكلمة مرورك لم تتغيّر ولا يلزم أي إجراء.',
      action: 'اختيار كلمة مرور جديدة',
    },
  },
  /*
   * Phase 4. Sent to an address that asked for a reset and has no account.
   *
   * WHY IT EXISTS AT ALL. Without it, the two branches of a reset request differ
   * in whether they touch the email provider — so when the provider is failing,
   * a registered address sees "we could not send that" and an unregistered one
   * sees the ordinary acknowledgement. That difference is an account-existence
   * oracle, and it appeared the moment the action stopped claiming success for a
   * send that failed. Sending BOTH through the same provider on the same request
   * is what makes the two outcomes identical, however the transport behaves.
   *
   * IT IS ALSO THE HONEST THING TO SEND. Somebody typed this address into a
   * password-reset form; the person who owns it is entitled to know.
   */
  'auth.password_reset.unknown': {
    EN: {
      subject: 'Reset your BrandSpace password',
      body: 'Someone asked to reset a BrandSpace password for this address, and there is no account here. If that was you, you may have used a different address. If it was not, no action is needed.',
      action: 'Go to BrandSpace',
    },
    AR: {
      subject: 'إعادة تعيين كلمة مرور BrandSpace',
      body: 'طلب أحدهم إعادة تعيين كلمة مرور BrandSpace لهذا العنوان، ولا يوجد حساب هنا. إن كنت أنت، فربما استخدمت عنوانًا آخر. وإن لم تكن، فلا يلزم أي إجراء.',
      action: 'الانتقال إلى BrandSpace',
    },
  },
  'workspace.invitation': {
    EN: {
      subject: 'You have been invited to a BrandSpace workspace',
      body: 'Someone invited you to work with them in BrandSpace. Accept the invitation to join.',
      action: 'Accept the invitation',
    },
    AR: {
      subject: 'دُعيت إلى مساحة عمل في BrandSpace',
      body: 'دعاك أحدهم للعمل معه في BrandSpace. اقبل الدعوة للانضمام.',
      action: 'قبول الدعوة',
    },
  },
  'workspace.invitation.resent': {
    EN: {
      subject: 'Your BrandSpace invitation, again',
      body: 'Here is your invitation again. The earlier link no longer works; this one does.',
      action: 'Accept the invitation',
    },
    AR: {
      subject: 'دعوتك إلى BrandSpace مرة أخرى',
      body: 'هذه دعوتك مرة أخرى. الرابط السابق لم يعد يعمل، وهذا الرابط يعمل.',
      action: 'قبول الدعوة',
    },
  },
  'workspace.suspended': {
    EN: {
      subject: 'Your BrandSpace workspace has been suspended',
      body: 'A workspace you belong to has been suspended. Its data is unchanged. Contact BrandSpace support to restore access.',
    },
    AR: {
      subject: 'تم تعليق مساحة عملك في BrandSpace',
      body: 'تم تعليق مساحة عمل تنتمي إليها. بياناتها لم تتغيّر. تواصل مع دعم BrandSpace لاستعادة الوصول.',
    },
  },
};

/** Escape for an HTML text node or a double-quoted attribute. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Turn a message into a subject and two bodies.
 *
 * THE LINK IS ESCAPED EVEN THOUGH WE BUILT IT. It is composed from a
 * deployment base URL and a token, both of ours — but this function is the last
 * place before the bytes leave the platform, and a renderer that trusts its
 * input because today's callers are trusted is a renderer that stops being
 * correct the first time a new one is added.
 */
const BRAND_PURPLE = '#7935FE';
const BRAND_YELLOW = '#FFDD15';
const BRAND_INK = '#111114';
const BRAND_MUTED = '#66666F';
const BRAND_SURFACE = '#F7F6FA';
const BRAND_BORDER = '#E8E5EF';

/**
 * Render the shared BrandSpace transactional shell.
 *
 * NO REMOTE ASSETS. A wordmark built from text and brand colour avoids image
 * blocking, broken asset URLs and another host that would need to be trusted by
 * every mail client. The message still makes sense when HTML is stripped
 * because `text` is rendered independently below.
 */
export function renderEmail(message: EmailMessageInput): RenderedEmail {
  const copy = TEMPLATES[message.templateKey][message.locale];
  const rtl = message.locale === 'AR';
  const dir = rtl ? 'rtl' : 'ltr';
  const align = rtl ? 'right' : 'left';

  const text = message.link ? `${copy.body}\n\n${message.link}\n` : `${copy.body}\n`;

  const safeLink = message.link ? escapeHtml(message.link) : '';
  const action =
    message.link && copy.action
      ? `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;margin-bottom:24px;">
          <tr>
            <td bgcolor="${BRAND_PURPLE}" style="background-color:${BRAND_PURPLE};border-radius:10px;">
              <a href="${safeLink}" style="display:inline-block;padding-top:13px;padding-right:20px;padding-bottom:13px;padding-left:20px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:20px;font-weight:700;color:#FFFFFF;text-decoration:none;">
                ${escapeHtml(copy.action)}
              </a>
            </td>
          </tr>
        </table>
        <p style="margin-top:0;margin-right:0;margin-bottom:8px;margin-left:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:${BRAND_MUTED};">
          ${rtl ? 'إذا لم يعمل الزر، انسخ هذا الرابط والصقه في المتصفح:' : 'If the button does not work, copy and paste this link into your browser:'}
        </p>
        <p style="margin-top:0;margin-right:0;margin-bottom:0;margin-left:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;word-break:break-all;color:${BRAND_PURPLE};">
          ${safeLink}
        </p>`
      : '';

  const html = `<!doctype html>
<html lang="${rtl ? 'ar' : 'en'}" dir="${dir}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${escapeHtml(copy.subject)}</title>
</head>
<body dir="${dir}" bgcolor="${BRAND_SURFACE}" style="margin:0;background-color:${BRAND_SURFACE};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND_SURFACE}" style="width:100%;background-color:${BRAND_SURFACE};">
    <tr>
      <td align="center" style="padding-top:40px;padding-right:16px;padding-bottom:40px;padding-left:16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
          <tr>
            <td align="${align}" style="padding-top:0;padding-right:0;padding-bottom:18px;padding-left:0;">
              <span style="font-family:Arial,Helvetica,sans-serif;font-size:22px;line-height:28px;font-weight:800;color:${BRAND_INK};letter-spacing:-0.4px;">BrandSpace</span>
              <span aria-hidden="true" style="display:inline-block;margin-left:6px;margin-right:6px;width:10px;height:10px;border-radius:999px;background-color:${BRAND_YELLOW};font-size:1px;line-height:1px;">&nbsp;</span>
            </td>
          </tr>
          <tr>
            <td bgcolor="#FFFFFF" style="background-color:#FFFFFF;border:1px solid ${BRAND_BORDER};border-radius:18px;padding-top:34px;padding-right:34px;padding-bottom:34px;padding-left:34px;text-align:${align};">
              <p style="margin-top:0;margin-right:0;margin-bottom:12px;margin-left:0;font-family:Arial,Helvetica,sans-serif;font-size:24px;line-height:32px;font-weight:800;color:${BRAND_INK};">
                ${escapeHtml(copy.subject)}
              </p>
              <p style="margin-top:0;margin-right:0;margin-bottom:0;margin-left:0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:${BRAND_MUTED};">
                ${escapeHtml(copy.body)}
              </p>
              ${action}
            </td>
          </tr>
          <tr>
            <td align="${align}" style="padding-top:16px;padding-right:4px;padding-bottom:0;padding-left:4px;">
              <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:17px;color:#8D8D96;">
                ${rtl ? 'هذه رسالة خدمية من BrandSpace مرتبطة بأمان حسابك أو مساحة عملك.' : 'This is a transactional BrandSpace message related to your account or workspace security.'}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject: copy.subject, text, html };
}

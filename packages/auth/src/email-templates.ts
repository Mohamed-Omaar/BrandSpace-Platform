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
 * DELIBERATELY PLAIN. No layout, no logo, no tracking pixel, no unsubscribe
 * footer: these are six transactional messages, and the one thing each must do
 * is carry a link that works. Design is a product decision this pass does not
 * take.
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
export function renderEmail(message: EmailMessageInput): RenderedEmail {
  const copy = TEMPLATES[message.templateKey][message.locale];
  const rtl = message.locale === 'AR';

  const text = message.link ? `${copy.body}\n\n${message.link}\n` : `${copy.body}\n`;

  const action =
    message.link && copy.action
      ? `<p><a href="${escapeHtml(message.link)}">${escapeHtml(copy.action)}</a></p>` +
        // The bare URL as well: a client that strips links leaves the reader
        // with nothing to act on otherwise.
        `<p>${escapeHtml(message.link)}</p>`
      : '';

  const html =
    `<!doctype html><html lang="${rtl ? 'ar' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}">` +
    `<body><p>${escapeHtml(copy.body)}</p>${action}</body></html>`;

  return { subject: copy.subject, text, html };
}

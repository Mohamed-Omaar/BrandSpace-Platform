import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OverlayStack, type StackedOverlay } from '../../packages/ui/src/overlay-stack';

/**
 * C8 (Phase 2B-2b) — THE OVERLAY STACK, AS A RULE (owner answer 7):
 * opening from outside closes the others; opening from inside stacks; Escape
 * closes only the top one. The browser half — a real sheet with a real dialog
 * on it — is `tests/e2e/prototype-v90-phase2b2b-shell.spec.ts`.
 */

type Fake = StackedOverlay & { readonly name: string; closed: number };

function overlay(id: number, name: string, inside: readonly string[] = []): Fake {
  const fake: Fake = {
    id,
    name,
    closed: 0,
    contains: (origin) => origin === name || inside.includes(String(origin)),
    close: () => {
      fake.closed += 1;
    },
  };
  return fake;
}

describe('OverlayStack', () => {
  it('opened from outside every overlay: the others are displaced', () => {
    const stack = new OverlayStack<Fake>();
    const menu = overlay(1, 'menu');
    expect(stack.open(menu, 'page-button')).toEqual([]);
    const sheet = overlay(2, 'sheet');
    expect(stack.open(sheet, 'page-button')).toEqual([menu]);
    expect(stack.entries).toEqual([sheet]);
  });

  it('opened from inside another: it stacks, and the one beneath stays', () => {
    const stack = new OverlayStack<Fake>();
    const sheet = overlay(1, 'sheet', ['delete-button']);
    stack.open(sheet, 'page-button');
    const dialog = overlay(2, 'dialog');
    expect(stack.open(dialog, 'delete-button')).toEqual([]);
    expect(stack.entries).toEqual([sheet, dialog]);
    expect(stack.top()).toBe(dialog);
  });

  it('Escape reaches the top only: closing it leaves the sheet open', () => {
    const stack = new OverlayStack<Fake>();
    const sheet = overlay(1, 'sheet', ['delete-button']);
    const dialog = overlay(2, 'dialog');
    stack.open(sheet, 'x');
    stack.open(dialog, 'delete-button');
    expect(stack.close(stack.top()!.id)).toEqual([]);
    expect(stack.entries).toEqual([sheet]);
  });

  it('opened from the lower of two: what was above it is displaced, what is below stays', () => {
    const stack = new OverlayStack<Fake>();
    const sheet = overlay(1, 'sheet', ['sheet-menu-trigger']);
    const menu = overlay(2, 'menu');
    stack.open(sheet, 'x');
    stack.open(menu, 'sheet-menu-trigger');
    const dialog = overlay(3, 'dialog');
    expect(stack.open(dialog, 'sheet-menu-trigger')).toEqual([menu]);
    expect(stack.entries).toEqual([sheet, dialog]);
  });

  it('closing a parent returns what was stacked on it, so nothing outlives its sheet', () => {
    const stack = new OverlayStack<Fake>();
    const sheet = overlay(1, 'sheet', ['delete-button']);
    const dialog = overlay(2, 'dialog');
    stack.open(sheet, 'x');
    stack.open(dialog, 'delete-button');
    expect(stack.close(sheet.id)).toEqual([dialog]);
    expect(stack.entries).toEqual([]);
  });

  it('a pointer inside an overlay stacked above is not "outside" the one beneath', () => {
    const stack = new OverlayStack<Fake>();
    const menu = overlay(1, 'menu', ['archive-item']);
    const dialog = overlay(2, 'dialog', ['confirm-button']);
    stack.open(menu, 'trigger');
    stack.open(dialog, 'archive-item');
    // Pressing Confirm must not close the menu — closing it would close the dialog.
    expect(stack.isAbove(menu.id, 'confirm-button')).toBe(true);
    // The page behind both is outside.
    expect(stack.isAbove(menu.id, 'page')).toBe(false);
    // Nothing is above the top.
    expect(stack.isAbove(dialog.id, 'archive-item')).toBe(false);
  });

  it('closing twice, or closing what is not open, changes nothing', () => {
    const stack = new OverlayStack<Fake>();
    const sheet = overlay(1, 'sheet');
    stack.open(sheet, 'x');
    stack.close(sheet.id);
    expect(stack.close(sheet.id)).toEqual([]);
    expect(stack.close(99)).toEqual([]);
    expect(stack.top()).toBeUndefined();
  });
});

describe('every managed overlay goes through the one stack', () => {
  const read = (file: string) => readFileSync(file, 'utf8');
  const overlays = read('packages/ui/src/overlays.tsx');

  it('there is exactly one document keydown listener, and it closes the top overlay', () => {
    expect(overlays.match(/addEventListener\('keydown'/g)).toHaveLength(1);
    expect(overlays).toContain("document.addEventListener('keydown', onOverlayKeyDown, true)");
    const handler = overlays.slice(
      overlays.indexOf('function onOverlayKeyDown'),
      overlays.indexOf('function syncKeyListener'),
    );
    expect(handler).toContain('const top = overlayStack.top();');
    expect(handler).toContain('top.close();');
  });

  it('the moved overlays use the shared hook, and none keeps a private Escape listener', () => {
    const managed: Record<string, number> = {
      // DropdownMenu, Dialog (and ConfirmDialog through it), SideSheet.
      'packages/ui/src/overlays.tsx': 3,
      // CopilotPanel as a phone sheet, CopilotDrawer.
      'packages/ui/src/copilot-shell.tsx': 2,
      'packages/ui/src/post-detail-drawer.tsx': 1,
      // The phone navigation drawer.
      'packages/ui/src/app-shell.tsx': 1,
    };
    for (const [file, count] of Object.entries(managed)) {
      const source = read(file);
      expect(source.match(/(?<!function )useOverlayBehaviour\(\{/g), file).toHaveLength(count);
      if (file !== 'packages/ui/src/overlays.tsx') {
        expect(source, file).not.toMatch(/addEventListener\('keydown'/);
      }
    }
  });

  it('comboboxes, tooltips and <details> stay outside the manager (owner answer 7, D8)', () => {
    for (const file of [
      'packages/ui/src/searchable-select.tsx',
      'apps/dashboard/src/components/mention-field.tsx',
    ]) {
      expect(read(file), file).not.toContain('useOverlayBehaviour');
    }
    const tooltip = overlays.slice(
      overlays.indexOf('export function Tooltip'),
      overlays.indexOf('export function DropdownMenu'),
    );
    expect(tooltip).not.toContain('useOverlayBehaviour');
  });

  it('focus goes back to the opener unless it already lives in the overlay that displaced this one', () => {
    expect(overlays).toContain(
      'if (!(active && overlayStack.anyContains(active))) restoreTo?.focus?.();',
    );
  });
});

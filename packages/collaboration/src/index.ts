/**
 * Contextual collaboration — Phase 6 (P6-05).
 *
 * Threads attached to work, notes inside them, and mentions that name the
 * people a note is addressed to.
 *
 * DELIBERATELY NOT PART OF `@brandspace/brand-brain`. A note is what a
 * colleague said; brand knowledge is what the brand has decided is true, with
 * provenance and an authority level, and it is what every AI surface generates
 * from. Keeping them in separate packages means the absence of a path between
 * them is visible in the dependency graph rather than resting on nobody writing
 * one.
 */
export { NotesService, NOTE_PERMISSION } from './notes';
export type {
  NoteActor,
  NoteInbox,
  NoteInboxEntry,
  NoteRecord,
  NoteSubject,
  NoteImportance,
  NoteSubjectType,
  NoteThreadStatus,
  NoteThreadSummary,
} from './notes';

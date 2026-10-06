// ponytail: the old module path, for the pipeline components that are not this lane's and still
// import it (log-application-dialog, application-detail-dialog). PG5 moves them to
// ./attempt-rules and deletes this file. The retired-word scan allows it.
export {
  ATTEMPT_STAGES as RECEIPT_STAGES,
  DESTINATION_PRESETS,
  MAX_ATTACHMENT_BYTES,
  PROVENANCE_LABELS,
  UNKNOWN_RESUME_DOCUMENT,
  resolveDestination,
} from './attempt-rules'

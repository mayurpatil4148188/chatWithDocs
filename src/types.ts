export type ProcessingStep = 'upload' | 'extract' | 'chunk' | 'index' | 'ready';
export type JobStatus = 'queued' | 'running' | 'complete' | 'failed';
export type DocumentStatus = 'uploading' | 'queued' | 'processing' | 'ready' | 'failed';

export interface GroundedCitation {
  citationId: string;
  documentId: string;
  documentVersionId: string;
  chunkId: string;
  pageStart: number;
  pageEnd: number;
  label: string;
}

export interface GroundedAnswer {
  text: string;
  grounding: 'supported' | 'partially_supported' | 'not_found';
  citations: GroundedCitation[];
}

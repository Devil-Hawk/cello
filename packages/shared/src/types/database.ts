export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      a2a_tasks: {
        Row: {
          agent: string
          created_at: string
          status: string
          task_id: string
          thread_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          agent: string
          created_at?: string
          status?: string
          task_id?: string
          thread_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          agent?: string
          created_at?: string
          status?: string
          task_id?: string
          thread_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "a2a_tasks_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "graph_threads"
            referencedColumns: ["thread_id"]
          },
          {
            foreignKeyName: "a2a_tasks_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      access_code_events: {
        Row: {
          action: string
          client_hint: string | null
          code_id: string
          detail: Json
          id: string
          kind: string
          occurred_at: string
          target: string | null
        }
        Insert: {
          action: string
          client_hint?: string | null
          code_id: string
          detail?: Json
          id?: string
          kind: string
          occurred_at?: string
          target?: string | null
        }
        Update: {
          action?: string
          client_hint?: string | null
          code_id?: string
          detail?: Json
          id?: string
          kind?: string
          occurred_at?: string
          target?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "access_code_events_code_id_fkey"
            columns: ["code_id"]
            isOneToOne: false
            referencedRelation: "access_codes"
            referencedColumns: ["id"]
          },
        ]
      }
      access_codes: {
        Row: {
          code_hash: string
          code_prefix: string
          created_at: string
          demo_user_id: string | null
          expires_at: string
          first_redeemed_at: string | null
          id: string
          label: string | null
          last_used_at: string | null
          owner_user_id: string
          provisioning_until: string | null
          redemption_count: number
          revoked_at: string | null
        }
        Insert: {
          code_hash: string
          code_prefix: string
          created_at?: string
          demo_user_id?: string | null
          expires_at: string
          first_redeemed_at?: string | null
          id?: string
          label?: string | null
          last_used_at?: string | null
          owner_user_id: string
          provisioning_until?: string | null
          redemption_count?: number
          revoked_at?: string | null
        }
        Update: {
          code_hash?: string
          code_prefix?: string
          created_at?: string
          demo_user_id?: string | null
          expires_at?: string
          first_redeemed_at?: string | null
          id?: string
          label?: string | null
          last_used_at?: string | null
          owner_user_id?: string
          provisioning_until?: string | null
          redemption_count?: number
          revoked_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "access_codes_demo_user_id_fkey"
            columns: ["demo_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "access_codes_owner_user_id_fkey"
            columns: ["owner_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      access_redeem_attempts: {
        Row: {
          bucket: string
          hits: number
          window_start: string
        }
        Insert: {
          bucket: string
          hits?: number
          window_start: string
        }
        Update: {
          bucket?: string
          hits?: number
          window_start?: string
        }
        Relationships: []
      }
      activities: {
        Row: {
          application_id: string
          created_at: string
          description: string | null
          id: string
          metadata: Json | null
          occurred_at: string
          title: string
          type: string
        }
        Insert: {
          application_id: string
          created_at?: string
          description?: string | null
          id?: string
          metadata?: Json | null
          occurred_at?: string
          title: string
          type: string
        }
        Update: {
          application_id?: string
          created_at?: string
          description?: string | null
          id?: string
          metadata?: Json | null
          occurred_at?: string
          title?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "activities_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_runs: {
        Row: {
          budget_tokens: number
          created_at: string
          error: string | null
          finished_at: string | null
          goal: string
          id: string
          plan: Json | null
          result: Json | null
          spent_tokens: number
          started_at: string | null
          status: string
          thread_id: string | null
          user_id: string
        }
        Insert: {
          budget_tokens?: number
          created_at?: string
          error?: string | null
          finished_at?: string | null
          goal: string
          id?: string
          plan?: Json | null
          result?: Json | null
          spent_tokens?: number
          started_at?: string | null
          status?: string
          thread_id?: string | null
          user_id: string
        }
        Update: {
          budget_tokens?: number
          created_at?: string
          error?: string | null
          finished_at?: string | null
          goal?: string
          id?: string
          plan?: Json | null
          result?: Json | null
          spent_tokens?: number
          started_at?: string | null
          status?: string
          thread_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_runs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      api_tokens: {
        Row: {
          created_at: string
          expires_at: string | null
          id: string
          last_used_at: string | null
          name: string
          revoked_at: string | null
          scopes: string[]
          token_hash: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          id?: string
          last_used_at?: string | null
          name: string
          revoked_at?: string | null
          scopes: string[]
          token_hash: string
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          id?: string
          last_used_at?: string | null
          name?: string
          revoked_at?: string | null
          scopes?: string[]
          token_hash?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_tokens_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      application_drafts: {
        Row: {
          answers: Json | null
          cover_letter: string | null
          created_at: string
          fill_state: Json | null
          id: string
          job_id: string
          resume_document_id: string | null
          resume_summary: string | null
          review_confirmed_at: string | null
          reviewed_at: string | null
          run_id: string | null
          screenshots: Json | null
          status: string
          submission_ref: string | null
          submitted_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          answers?: Json | null
          cover_letter?: string | null
          created_at?: string
          fill_state?: Json | null
          id?: string
          job_id: string
          resume_document_id?: string | null
          resume_summary?: string | null
          review_confirmed_at?: string | null
          reviewed_at?: string | null
          run_id?: string | null
          screenshots?: Json | null
          status?: string
          submission_ref?: string | null
          submitted_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          answers?: Json | null
          cover_letter?: string | null
          created_at?: string
          fill_state?: Json | null
          id?: string
          job_id?: string
          resume_document_id?: string | null
          resume_summary?: string | null
          review_confirmed_at?: string | null
          reviewed_at?: string | null
          run_id?: string | null
          screenshots?: Json | null
          status?: string
          submission_ref?: string | null
          submitted_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "application_drafts_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_drafts_resume_document_id_fkey"
            columns: ["resume_document_id"]
            isOneToOne: false
            referencedRelation: "resume_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_drafts_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_drafts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      application_receipts: {
        Row: {
          application_id: string
          confirmation_attachment_url: string | null
          confirmation_identifier: string | null
          confirmation_note: string | null
          created_at: string
          destination: string | null
          documents: Json
          id: string
          provenance: string
          source_detail: Json | null
          submitted_at: string
          updated_at: string
          user_id: string
          verification_state: string
        }
        Insert: {
          application_id: string
          confirmation_attachment_url?: string | null
          confirmation_identifier?: string | null
          confirmation_note?: string | null
          created_at?: string
          destination?: string | null
          documents?: Json
          id?: string
          provenance?: string
          source_detail?: Json | null
          submitted_at: string
          updated_at?: string
          user_id: string
          verification_state?: string
        }
        Update: {
          application_id?: string
          confirmation_attachment_url?: string | null
          confirmation_identifier?: string | null
          confirmation_note?: string | null
          created_at?: string
          destination?: string | null
          documents?: Json
          id?: string
          provenance?: string
          source_detail?: Json | null
          submitted_at?: string
          updated_at?: string
          user_id?: string
          verification_state?: string
        }
        Relationships: [
          {
            foreignKeyName: "application_receipts_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_receipts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      applications: {
        Row: {
          applied_at: string | null
          cover_letter: string | null
          created_at: string
          id: string
          job_id: string
          notes: string | null
          resume_version: string | null
          source: string | null
          stage: string
          updated_at: string
          user_id: string
        }
        Insert: {
          applied_at?: string | null
          cover_letter?: string | null
          created_at?: string
          id?: string
          job_id: string
          notes?: string | null
          resume_version?: string | null
          source?: string | null
          stage?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          applied_at?: string | null
          cover_letter?: string | null
          created_at?: string
          id?: string
          job_id?: string
          notes?: string | null
          resume_version?: string | null
          source?: string | null
          stage?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "applications_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "applications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      apply_credentials: {
        Row: {
          created_at: string
          encrypted_secret: string
          host: string
          id: string
          label: string
          last_used_at: string | null
          provider: string | null
          updated_at: string
          user_id: string
          username: string
        }
        Insert: {
          created_at?: string
          encrypted_secret: string
          host: string
          id?: string
          label: string
          last_used_at?: string | null
          provider?: string | null
          updated_at?: string
          user_id: string
          username: string
        }
        Update: {
          created_at?: string
          encrypted_secret?: string
          host?: string
          id?: string
          label?: string
          last_used_at?: string | null
          provider?: string | null
          updated_at?: string
          user_id?: string
          username?: string
        }
        Relationships: [
          {
            foreignKeyName: "apply_credentials_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      apply_phase_tokens: {
        Row: {
          consumed_at: string | null
          draft_id: string
          expires_at: string
          id: string
          issued_at: string
          phase: string
          token_hash: string
          user_id: string
        }
        Insert: {
          consumed_at?: string | null
          draft_id: string
          expires_at: string
          id?: string
          issued_at?: string
          phase: string
          token_hash: string
          user_id: string
        }
        Update: {
          consumed_at?: string | null
          draft_id?: string
          expires_at?: string
          id?: string
          issued_at?: string
          phase?: string
          token_hash?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "apply_phase_tokens_draft_id_fkey"
            columns: ["draft_id"]
            isOneToOne: false
            referencedRelation: "application_drafts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "apply_phase_tokens_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      claim_evidence: {
        Row: {
          claim_id: string
          created_at: string
          id: string
          kb_chunk_id: string | null
          kb_document_id: string | null
          quote: string
          strength: string
          user_id: string
        }
        Insert: {
          claim_id: string
          created_at?: string
          id?: string
          kb_chunk_id?: string | null
          kb_document_id?: string | null
          quote: string
          strength: string
          user_id: string
        }
        Update: {
          claim_id?: string
          created_at?: string
          id?: string
          kb_chunk_id?: string | null
          kb_document_id?: string | null
          quote?: string
          strength?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "claim_evidence_claim_id_fkey"
            columns: ["claim_id"]
            isOneToOne: false
            referencedRelation: "resume_claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_evidence_kb_chunk_id_fkey"
            columns: ["kb_chunk_id"]
            isOneToOne: false
            referencedRelation: "kb_chunks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_evidence_kb_document_id_fkey"
            columns: ["kb_document_id"]
            isOneToOne: false
            referencedRelation: "kb_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claim_evidence_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      companies: {
        Row: {
          canonical_id: string | null
          career_url: string
          created_at: string
          domain: string | null
          id: string
          is_dream_company: boolean
          last_scraped_at: string | null
          logo_url: string | null
          metadata: Json | null
          name: string
          name_key: string | null
          notes: string | null
          scrape_frequency: number
          user_id: string
        }
        Insert: {
          canonical_id?: string | null
          career_url: string
          created_at?: string
          domain?: string | null
          id?: string
          is_dream_company?: boolean
          last_scraped_at?: string | null
          logo_url?: string | null
          metadata?: Json | null
          name: string
          name_key?: string | null
          notes?: string | null
          scrape_frequency?: number
          user_id: string
        }
        Update: {
          canonical_id?: string | null
          career_url?: string
          created_at?: string
          domain?: string | null
          id?: string
          is_dream_company?: boolean
          last_scraped_at?: string | null
          logo_url?: string | null
          metadata?: Json | null
          name?: string
          name_key?: string | null
          notes?: string | null
          scrape_frequency?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "companies_canonical_id_fkey"
            columns: ["canonical_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "companies_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      company_dossiers: {
        Row: {
          comp_intel: Json | null
          company_id: string
          created_at: string
          id: string
          refreshed_at: string
          signals: Json | null
          sources: Json | null
          sponsors_visa: string | null
          summary: string | null
          user_id: string
        }
        Insert: {
          comp_intel?: Json | null
          company_id: string
          created_at?: string
          id?: string
          refreshed_at?: string
          signals?: Json | null
          sources?: Json | null
          sponsors_visa?: string | null
          summary?: string | null
          user_id: string
        }
        Update: {
          comp_intel?: Json | null
          company_id?: string
          created_at?: string
          id?: string
          refreshed_at?: string
          signals?: Json | null
          sources?: Json | null
          sponsors_visa?: string | null
          summary?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_dossiers_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: true
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_dossiers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      company_merge_candidates: {
        Row: {
          company_a: string
          company_b: string
          created_at: string
          id: string
          reason: string
          score: number
          status: string
          user_id: string
        }
        Insert: {
          company_a: string
          company_b: string
          created_at?: string
          id?: string
          reason: string
          score: number
          status?: string
          user_id: string
        }
        Update: {
          company_a?: string
          company_b?: string
          created_at?: string
          id?: string
          reason?: string
          score?: number
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_merge_candidates_company_a_fkey"
            columns: ["company_a"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_merge_candidates_company_b_fkey"
            columns: ["company_b"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_merge_candidates_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          basis: string | null
          company_id: string | null
          confidence: number | null
          created_at: string
          email: string | null
          id: string
          last_contact_at: string | null
          linkedin_url: string | null
          name: string
          notes: string | null
          relationship: string | null
          source: string | null
          title: string | null
          user_id: string
          verified: boolean
        }
        Insert: {
          basis?: string | null
          company_id?: string | null
          confidence?: number | null
          created_at?: string
          email?: string | null
          id?: string
          last_contact_at?: string | null
          linkedin_url?: string | null
          name: string
          notes?: string | null
          relationship?: string | null
          source?: string | null
          title?: string | null
          user_id: string
          verified?: boolean
        }
        Update: {
          basis?: string | null
          company_id?: string | null
          confidence?: number | null
          created_at?: string
          email?: string | null
          id?: string
          last_contact_at?: string | null
          linkedin_url?: string | null
          name?: string
          notes?: string | null
          relationship?: string | null
          source?: string | null
          title?: string | null
          user_id?: string
          verified?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "contacts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      copilot_conversations: {
        Row: {
          bypass_mode: boolean
          created_at: string
          enabled_agents: Json | null
          id: string
          model: string | null
          summary: string | null
          summary_through_message_id: string | null
          thread_id: string | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          bypass_mode?: boolean
          created_at?: string
          enabled_agents?: Json | null
          id?: string
          model?: string | null
          summary?: string | null
          summary_through_message_id?: string | null
          thread_id?: string | null
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          bypass_mode?: boolean
          created_at?: string
          enabled_agents?: Json | null
          id?: string
          model?: string | null
          summary?: string | null
          summary_through_message_id?: string | null
          thread_id?: string | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      copilot_messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string
          id: string
          role: string
          trace: Json | null
          user_id: string
        }
        Insert: {
          content: string
          conversation_id: string
          created_at?: string
          id?: string
          role: string
          trace?: Json | null
          user_id: string
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
          role?: string
          trace?: Json | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "copilot_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "copilot_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      eval_verdicts: {
        Row: {
          created_at: string
          id: string
          judge: string
          model: string | null
          rationale: string | null
          run_id: string | null
          score: number | null
          span_id: string | null
          subject_id: string
          subject_kind: string
          threshold: number | null
          tokens_used: number | null
          user_id: string
          verdict: string
        }
        Insert: {
          created_at?: string
          id?: string
          judge: string
          model?: string | null
          rationale?: string | null
          run_id?: string | null
          score?: number | null
          span_id?: string | null
          subject_id: string
          subject_kind: string
          threshold?: number | null
          tokens_used?: number | null
          user_id: string
          verdict: string
        }
        Update: {
          created_at?: string
          id?: string
          judge?: string
          model?: string | null
          rationale?: string | null
          run_id?: string | null
          score?: number | null
          span_id?: string | null
          subject_id?: string
          subject_kind?: string
          threshold?: number | null
          tokens_used?: number | null
          user_id?: string
          verdict?: string
        }
        Relationships: [
          {
            foreignKeyName: "eval_verdicts_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "eval_verdicts_span_id_fkey"
            columns: ["span_id"]
            isOneToOne: false
            referencedRelation: "trace_spans"
            referencedColumns: ["span_id"]
          },
          {
            foreignKeyName: "eval_verdicts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      follow_ups: {
        Row: {
          application_id: string | null
          completed_at: string | null
          contact_id: string | null
          created_at: string
          due_date: string
          id: string
          is_completed: boolean
          note: string
        }
        Insert: {
          application_id?: string | null
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string
          due_date: string
          id?: string
          is_completed?: boolean
          note: string
        }
        Update: {
          application_id?: string | null
          completed_at?: string | null
          contact_id?: string | null
          created_at?: string
          due_date?: string
          id?: string
          is_completed?: boolean
          note?: string
        }
        Relationships: [
          {
            foreignKeyName: "follow_ups_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_ups_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      graph_threads: {
        Row: {
          conversation_id: string | null
          created_at: string
          expires_at: string | null
          last_invoked_at: string | null
          pending_dispatch: Json | null
          run_id: string | null
          surface: string
          thread_id: string
          user_id: string
        }
        Insert: {
          conversation_id?: string | null
          created_at?: string
          expires_at?: string | null
          last_invoked_at?: string | null
          pending_dispatch?: Json | null
          run_id?: string | null
          surface: string
          thread_id?: string
          user_id: string
        }
        Update: {
          conversation_id?: string | null
          created_at?: string
          expires_at?: string | null
          last_invoked_at?: string | null
          pending_dispatch?: Json | null
          run_id?: string | null
          surface?: string
          thread_id?: string
          user_id?: string
        }
        Relationships: []
      }
      ingestion_locks: {
        Row: {
          acquired_at: string
          expires_at: string
          holder: string
          name: string
        }
        Insert: {
          acquired_at?: string
          expires_at: string
          holder: string
          name: string
        }
        Update: {
          acquired_at?: string
          expires_at?: string
          holder?: string
          name?: string
        }
        Relationships: []
      }
      ingestion_runs: {
        Row: {
          batch_id: string
          by_provider: Json
          companies_checked: number
          companies_failed: number
          companies_total: number
          duration_ms: number | null
          failed_companies: Json
          failures_by_provider: Json
          finished_at: string | null
          id: string
          jobs_closed: number
          jobs_found: number
          jobs_new: number
          jobs_updated: number
          model_calls: number
          partial_reason: string | null
          started_at: string
          status: string
          task: string
          trigger: string
          user_id: string
        }
        Insert: {
          batch_id: string
          by_provider?: Json
          companies_checked?: number
          companies_failed?: number
          companies_total?: number
          duration_ms?: number | null
          failed_companies?: Json
          failures_by_provider?: Json
          finished_at?: string | null
          id?: string
          jobs_closed?: number
          jobs_found?: number
          jobs_new?: number
          jobs_updated?: number
          model_calls?: number
          partial_reason?: string | null
          started_at?: string
          status?: string
          task?: string
          trigger?: string
          user_id: string
        }
        Update: {
          batch_id?: string
          by_provider?: Json
          companies_checked?: number
          companies_failed?: number
          companies_total?: number
          duration_ms?: number | null
          failed_companies?: Json
          failures_by_provider?: Json
          finished_at?: string | null
          id?: string
          jobs_closed?: number
          jobs_found?: number
          jobs_new?: number
          jobs_updated?: number
          model_calls?: number
          partial_reason?: string | null
          started_at?: string
          status?: string
          task?: string
          trigger?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ingestion_runs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      insights: {
        Row: {
          company_id: string | null
          confidence: number | null
          created_at: string
          embedding: string | null
          evidence: Json | null
          id: string
          kind: string
          source: string
          statement: string
          status: string
          supersedes_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          company_id?: string | null
          confidence?: number | null
          created_at?: string
          embedding?: string | null
          evidence?: Json | null
          id?: string
          kind: string
          source: string
          statement: string
          status?: string
          supersedes_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          company_id?: string | null
          confidence?: number | null
          created_at?: string
          embedding?: string | null
          evidence?: Json | null
          id?: string
          kind?: string
          source?: string
          statement?: string
          status?: string
          supersedes_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "insights_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "insights_supersedes_id_fkey"
            columns: ["supersedes_id"]
            isOneToOne: false
            referencedRelation: "insights"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "insights_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      interactions: {
        Row: {
          application_id: string | null
          body: string | null
          company_id: string | null
          contact_id: string | null
          created_at: string
          id: string
          job_id: string | null
          kind: string
          metadata: Json | null
          occurred_at: string
          ref_id: string
          ref_table: string
          title: string | null
          user_id: string
        }
        Insert: {
          application_id?: string | null
          body?: string | null
          company_id?: string | null
          contact_id?: string | null
          created_at?: string
          id?: string
          job_id?: string | null
          kind: string
          metadata?: Json | null
          occurred_at: string
          ref_id: string
          ref_table: string
          title?: string | null
          user_id: string
        }
        Update: {
          application_id?: string | null
          body?: string | null
          company_id?: string | null
          contact_id?: string | null
          created_at?: string
          id?: string
          job_id?: string | null
          kind?: string
          metadata?: Json | null
          occurred_at?: string
          ref_id?: string
          ref_table?: string
          title?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "interactions_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interactions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interactions_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interactions_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          closed_at: string | null
          company_id: string
          country: string | null
          description: string
          description_md5: string | null
          discovered_at: string
          external_id: string | null
          id: string
          is_new: boolean
          is_remote: boolean | null
          job_function: string | null
          job_type: string | null
          language: string | null
          last_seen_at: string
          last_verified_at: string | null
          location: string | null
          match_details: Json | null
          match_score: number | null
          missed_checks: number
          posted_at: string | null
          quality_score: number | null
          requirements: Json | null
          requirements_extracted_at: string | null
          salary_range: string | null
          seniority: string | null
          source: string | null
          still_open: boolean | null
          title: string
          tsv: unknown
          url: string
        }
        Insert: {
          closed_at?: string | null
          company_id: string
          country?: string | null
          description: string
          description_md5?: string | null
          discovered_at?: string
          external_id?: string | null
          id?: string
          is_new?: boolean
          is_remote?: boolean | null
          job_function?: string | null
          job_type?: string | null
          language?: string | null
          last_seen_at?: string
          last_verified_at?: string | null
          location?: string | null
          match_details?: Json | null
          match_score?: number | null
          missed_checks?: number
          posted_at?: string | null
          quality_score?: number | null
          requirements?: Json | null
          requirements_extracted_at?: string | null
          salary_range?: string | null
          seniority?: string | null
          source?: string | null
          still_open?: boolean | null
          title: string
          tsv?: unknown
          url: string
        }
        Update: {
          closed_at?: string | null
          company_id?: string
          country?: string | null
          description?: string
          description_md5?: string | null
          discovered_at?: string
          external_id?: string | null
          id?: string
          is_new?: boolean
          is_remote?: boolean | null
          job_function?: string | null
          job_type?: string | null
          language?: string | null
          last_seen_at?: string
          last_verified_at?: string | null
          location?: string | null
          match_details?: Json | null
          match_score?: number | null
          missed_checks?: number
          posted_at?: string | null
          quality_score?: number | null
          requirements?: Json | null
          requirements_extracted_at?: string | null
          salary_range?: string | null
          seniority?: string | null
          source?: string | null
          still_open?: boolean | null
          title?: string
          tsv?: unknown
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "jobs_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      kb_chunks: {
        Row: {
          content: string
          created_at: string
          document_id: string
          embedding: string | null
          id: string
          ord: number
          tsv: unknown
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          document_id: string
          embedding?: string | null
          id?: string
          ord: number
          tsv?: unknown
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          document_id?: string
          embedding?: string | null
          id?: string
          ord?: number
          tsv?: unknown
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "kb_chunks_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "kb_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kb_chunks_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      kb_documents: {
        Row: {
          company_id: string | null
          contact_id: string | null
          content: string
          created_at: string
          external_id: string | null
          id: string
          job_id: string | null
          metadata: Json | null
          source_id: string
          title: string | null
          updated_at: string
          url: string | null
          user_id: string
        }
        Insert: {
          company_id?: string | null
          contact_id?: string | null
          content: string
          created_at?: string
          external_id?: string | null
          id?: string
          job_id?: string | null
          metadata?: Json | null
          source_id: string
          title?: string | null
          updated_at?: string
          url?: string | null
          user_id: string
        }
        Update: {
          company_id?: string | null
          contact_id?: string | null
          content?: string
          created_at?: string
          external_id?: string | null
          id?: string
          job_id?: string | null
          metadata?: Json | null
          source_id?: string
          title?: string | null
          updated_at?: string
          url?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "kb_documents_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kb_documents_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kb_documents_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kb_documents_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "kb_sources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kb_documents_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      kb_sources: {
        Row: {
          config: Json | null
          created_at: string
          enabled: boolean
          id: string
          kind: string
          label: string | null
          last_error: string | null
          last_synced_at: string | null
          user_id: string
        }
        Insert: {
          config?: Json | null
          created_at?: string
          enabled?: boolean
          id?: string
          kind: string
          label?: string | null
          last_error?: string | null
          last_synced_at?: string | null
          user_id: string
        }
        Update: {
          config?: Json | null
          created_at?: string
          enabled?: boolean
          id?: string
          kind?: string
          label?: string | null
          last_error?: string | null
          last_synced_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "kb_sources_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      llm_spend: {
        Row: {
          actual_usd: number | null
          created_at: string
          door: string | null
          estimate_usd: number
          failed_status: number | null
          funder_id: string | null
          id: string
          model: string
          period: string
          rung: string
          settled_at: string | null
          status: string
          step: string
          trace_id: string | null
          user_id: string
        }
        Insert: {
          actual_usd?: number | null
          created_at?: string
          door?: string | null
          estimate_usd: number
          failed_status?: number | null
          funder_id?: string | null
          id?: string
          model: string
          period: string
          rung: string
          settled_at?: string | null
          status?: string
          step: string
          trace_id?: string | null
          user_id: string
        }
        Update: {
          actual_usd?: number | null
          created_at?: string
          door?: string | null
          estimate_usd?: number
          failed_status?: number | null
          funder_id?: string | null
          id?: string
          model?: string
          period?: string
          rung?: string
          settled_at?: string | null
          status?: string
          step?: string
          trace_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "llm_spend_funder_id_fkey"
            columns: ["funder_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "llm_spend_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      outreach_messages: {
        Row: {
          body: string
          company_id: string | null
          contact_id: string | null
          created_at: string
          error: string | null
          gmail_message_id: string | null
          gmail_thread_id: string | null
          id: string
          job_id: string | null
          kind: string
          parent_id: string | null
          replied_at: string | null
          reply_classification: string | null
          reply_gmail_message_id: string | null
          run_id: string | null
          sent_at: string | null
          status: string
          subject: string
          to_email: string
          to_name: string | null
          updated_at: string
          used_llm: boolean | null
          user_id: string
        }
        Insert: {
          body: string
          company_id?: string | null
          contact_id?: string | null
          created_at?: string
          error?: string | null
          gmail_message_id?: string | null
          gmail_thread_id?: string | null
          id?: string
          job_id?: string | null
          kind?: string
          parent_id?: string | null
          replied_at?: string | null
          reply_classification?: string | null
          reply_gmail_message_id?: string | null
          run_id?: string | null
          sent_at?: string | null
          status?: string
          subject: string
          to_email: string
          to_name?: string | null
          updated_at?: string
          used_llm?: boolean | null
          user_id: string
        }
        Update: {
          body?: string
          company_id?: string | null
          contact_id?: string | null
          created_at?: string
          error?: string | null
          gmail_message_id?: string | null
          gmail_thread_id?: string | null
          id?: string
          job_id?: string | null
          kind?: string
          parent_id?: string | null
          replied_at?: string | null
          reply_classification?: string | null
          reply_gmail_message_id?: string | null
          run_id?: string | null
          sent_at?: string | null
          status?: string
          subject?: string
          to_email?: string
          to_name?: string | null
          updated_at?: string
          used_llm?: boolean | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "outreach_messages_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outreach_messages_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outreach_messages_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outreach_messages_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "outreach_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outreach_messages_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outreach_messages_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          demo_expires_at: string | null
          email: string
          full_name: string | null
          id: string
          is_demo: boolean
          preferences: Json | null
          resume_text: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          demo_expires_at?: string | null
          email: string
          full_name?: string | null
          id: string
          is_demo?: boolean
          preferences?: Json | null
          resume_text?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          demo_expires_at?: string | null
          email?: string
          full_name?: string | null
          id?: string
          is_demo?: boolean
          preferences?: Json | null
          resume_text?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      resume_claims: {
        Row: {
          claim_kind: string
          claim_text: string
          created_at: string
          embedding: string | null
          id: string
          normalized_key: string | null
          resume_document_id: string | null
          user_id: string
        }
        Insert: {
          claim_kind: string
          claim_text: string
          created_at?: string
          embedding?: string | null
          id?: string
          normalized_key?: string | null
          resume_document_id?: string | null
          user_id: string
        }
        Update: {
          claim_kind?: string
          claim_text?: string
          created_at?: string
          embedding?: string | null
          id?: string
          normalized_key?: string | null
          resume_document_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "resume_claims_resume_document_id_fkey"
            columns: ["resume_document_id"]
            isOneToOne: false
            referencedRelation: "resume_documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "resume_claims_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      resume_documents: {
        Row: {
          ats_score: number | null
          content: string
          content_json: Json | null
          created_at: string
          draft_id: string | null
          id: string
          job_id: string | null
          source: string | null
          title: string | null
          updated_at: string
          user_id: string
          version: number
        }
        Insert: {
          ats_score?: number | null
          content: string
          content_json?: Json | null
          created_at?: string
          draft_id?: string | null
          id?: string
          job_id?: string | null
          source?: string | null
          title?: string | null
          updated_at?: string
          user_id: string
          version: number
        }
        Update: {
          ats_score?: number | null
          content?: string
          content_json?: Json | null
          created_at?: string
          draft_id?: string | null
          id?: string
          job_id?: string | null
          source?: string | null
          title?: string | null
          updated_at?: string
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "resume_documents_draft_id_fkey"
            columns: ["draft_id"]
            isOneToOne: false
            referencedRelation: "application_drafts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "resume_documents_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "resume_documents_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      strategy_proposal_outcomes: {
        Row: {
          accepted_at: string
          created_at: string
          id: string
          metrics_before: Json
          proposal_id: string
          question: string
          title: string
          user_id: string
        }
        Insert: {
          accepted_at: string
          created_at?: string
          id?: string
          metrics_before: Json
          proposal_id: string
          question: string
          title: string
          user_id: string
        }
        Update: {
          accepted_at?: string
          created_at?: string
          id?: string
          metrics_before?: Json
          proposal_id?: string
          question?: string
          title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "strategy_proposal_outcomes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      trace_spans: {
        Row: {
          attributes: Json | null
          end_time: string | null
          events: Json | null
          kind: string
          name: string
          parent_span_id: string | null
          run_id: string | null
          span_id: string
          start_time: string
          status: string | null
          thread_id: string | null
          trace_id: string
          user_id: string
        }
        Insert: {
          attributes?: Json | null
          end_time?: string | null
          events?: Json | null
          kind: string
          name: string
          parent_span_id?: string | null
          run_id?: string | null
          span_id?: string
          start_time: string
          status?: string | null
          thread_id?: string | null
          trace_id: string
          user_id: string
        }
        Update: {
          attributes?: Json | null
          end_time?: string | null
          events?: Json | null
          kind?: string
          name?: string
          parent_span_id?: string | null
          run_id?: string | null
          span_id?: string
          start_time?: string
          status?: string | null
          thread_id?: string | null
          trace_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trace_spans_parent_span_id_fkey"
            columns: ["parent_span_id"]
            isOneToOne: false
            referencedRelation: "trace_spans"
            referencedColumns: ["span_id"]
          },
          {
            foreignKeyName: "trace_spans_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trace_spans_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "graph_threads"
            referencedColumns: ["thread_id"]
          },
          {
            foreignKeyName: "trace_spans_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_mcp_servers: {
        Row: {
          created_at: string
          enabled: boolean
          headers: string | null
          id: string
          last_connected_at: string | null
          last_error: string | null
          name: string
          transport: string
          url: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          headers?: string | null
          id?: string
          last_connected_at?: string | null
          last_error?: string | null
          name: string
          transport: string
          url?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          headers?: string | null
          id?: string
          last_connected_at?: string | null
          last_error?: string | null
          name?: string
          transport?: string
          url?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_mcp_servers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      acquire_ingestion_lock: {
        Args: { p_holder: string; p_lease_minutes?: number; p_name: string }
        Returns: boolean
      }
      clear_unverified_board_jobs: {
        Args: { p_company_id: string; p_source: string }
        Returns: {
          closed: number
          deleted: number
        }[]
      }
      delete_unreferenced_gmail_suggestions: { Args: never; Returns: number }
      demo_allowance_state: { Args: { p_owner_id: string }; Returns: Json }
      demo_allowance_usd: { Args: never; Returns: number }
      distill_draft_by_seniority: {
        Args: { p_user_id: string }
        Returns: {
          band: string
          negative_count: number
          positive_count: number
          verdict_ids: string[]
        }[]
      }
      distill_match_score_by_score_band: {
        Args: { p_user_id: string }
        Returns: {
          band: string
          negative_count: number
          positive_count: number
          verdict_ids: string[]
        }[]
      }
      distill_match_score_by_source: {
        Args: { p_user_id: string }
        Returns: {
          band: string
          negative_count: number
          positive_count: number
          verdict_ids: string[]
        }[]
      }
      distill_outreach_by_company: {
        Args: { p_user_id: string }
        Returns: {
          company_id: string
          negative_count: number
          positive_count: number
          verdict_ids: string[]
        }[]
      }
      evict_company_jobs: {
        Args: { p_company_id: string; p_external_ids: string[] }
        Returns: string[]
      }
      find_company_merge_candidates: {
        Args: { p_threshold?: number; p_user_id: string }
        Returns: {
          company_a: string
          company_b: string
          score: number
        }[]
      }
      finish_access_code_provisioning: {
        Args: { p_code_id: string; p_demo_user_id: string }
        Returns: boolean
      }
      get_client_safe_preferences: { Args: never; Returns: Json }
      is_service_role_request: { Args: never; Returns: boolean }
      llm_spend_state: { Args: { p_user_id: string }; Returns: Json }
      mint_access_code: {
        Args: {
          p_code_hash: string
          p_code_prefix: string
          p_expires_at: string
          p_label: string
          p_owner_id: string
        }
        Returns: {
          code_hash: string
          code_prefix: string
          created_at: string
          demo_user_id: string | null
          expires_at: string
          first_redeemed_at: string | null
          id: string
          label: string | null
          last_used_at: string | null
          owner_user_id: string
          provisioning_until: string | null
          redemption_count: number
          revoked_at: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "access_codes"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      note_redeem_attempt: { Args: { p_client: string }; Returns: boolean }
      profile_is_demo: { Args: { target: string }; Returns: boolean }
      prune_redeem_attempts: { Args: never; Returns: number }
      prune_stale_rows: { Args: never; Returns: Json }
      record_job_sightings: {
        Args: {
          p_close_after?: number
          p_company_id: string
          p_external_ids: string[]
          p_seen_at?: string
          p_sources: string[]
        }
        Returns: Json
      }
      redeem_access_code: { Args: { p_hashes: string[] }; Returns: Json }
      release_ingestion_lock: {
        Args: { p_holder: string; p_name: string }
        Returns: undefined
      }
      reserve_llm_spend: {
        Args: {
          p_door?: string
          p_estimate: number
          p_model: string
          p_rung: string
          p_step: string
          p_trace_id?: string
          p_user_id: string
        }
        Returns: Json
      }
      revoke_access_code: {
        Args: { p_code_id: string; p_owner_id: string }
        Returns: Json
      }
      search_contacts_by_name_trgm: {
        Args: { p_limit?: number; p_query: string; p_user_id: string }
        Returns: {
          contact_id: string
          score: number
        }[]
      }
      search_insights: {
        Args: {
          p_kinds?: string[]
          p_limit?: number
          p_user_id: string
          p_vec?: string
        }
        Returns: {
          company_id: string
          confidence: number
          created_at: string
          evidence: Json
          id: string
          kind: string
          source: string
          statement: string
          status: string
          supersedes_id: string
          updated_at: string
        }[]
      }
      search_jobs_by_title_trgm: {
        Args: { p_limit?: number; p_query: string; p_user_id: string }
        Returns: {
          job_id: string
          score: number
        }[]
      }
      search_kb_chunks: {
        Args: {
          p_company_id?: string
          p_limit?: number
          p_query: string
          p_user_id: string
          p_vec?: string
        }
        Returns: {
          chunk_id: string
          content: string
          document_id: string
          ord: number
          rank: number
          source_id: string
          title: string
          url: string
        }[]
      }
      set_onboarding_preferences: {
        Args: { p_match_threshold: number; p_onboarded_at?: string }
        Returns: undefined
      }
      settle_llm_spend: {
        Args: { p_actual: number; p_id: string; p_status?: number }
        Returns: boolean
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      sweep_llm_spend: { Args: never; Returns: Json }
      upsert_insight: {
        Args: {
          p_company_id: string
          p_confidence: number
          p_evidence: Json
          p_kind: string
          p_source: string
          p_statement: string
          p_user_id: string
        }
        Returns: {
          company_id: string
          confidence: number
          created_at: string
          evidence: Json
          id: string
          inserted: boolean
          kind: string
          source: string
          statement: string
          status: string
          supersedes_id: string
          updated_at: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const


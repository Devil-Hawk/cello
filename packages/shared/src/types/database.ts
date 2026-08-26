// Supabase Database types
// These are auto-generated based on the schema

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string
          email: string
          full_name: string | null
          avatar_url: string | null
          resume_text: string | null
          resume_embedding: number[] | null
          preferences: Json | null
          api_keys: Json | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          email: string
          full_name?: string | null
          avatar_url?: string | null
          resume_text?: string | null
          resume_embedding?: number[] | null
          preferences?: Json | null
          api_keys?: Json | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          email?: string
          full_name?: string | null
          avatar_url?: string | null
          resume_text?: string | null
          resume_embedding?: number[] | null
          preferences?: Json | null
          api_keys?: Json | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      companies: {
        Row: {
          id: string
          user_id: string
          name: string
          domain: string | null
          logo_url: string | null
          career_url: string
          scrape_frequency: number
          last_scraped_at: string | null
          is_dream_company: boolean
          notes: string | null
          // Optional because the additive metadata migration may not be applied yet
          metadata?: Json | null
          created_at: string
          // Optional because the additive company-identity migration may not be applied yet
          name_key?: string | null
          canonical_id?: string | null
        }
        Insert: {
          id?: string
          user_id: string
          name: string
          domain?: string | null
          logo_url?: string | null
          career_url: string
          scrape_frequency?: number
          last_scraped_at?: string | null
          is_dream_company?: boolean
          notes?: string | null
          metadata?: Json | null
          created_at?: string
          name_key?: string | null
          canonical_id?: string | null
        }
        Update: {
          id?: string
          user_id?: string
          name?: string
          domain?: string | null
          logo_url?: string | null
          career_url?: string
          scrape_frequency?: number
          last_scraped_at?: string | null
          is_dream_company?: boolean
          notes?: string | null
          metadata?: Json | null
          created_at?: string
          name_key?: string | null
          canonical_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "companies_user_id_fkey"
            columns: ["user_id"]
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          }
        ]
      }
      jobs: {
        Row: {
          id: string
          company_id: string
          title: string
          description: string
          url: string
          location: string | null
          salary_range: string | null
          job_type: string | null
          posted_at: string | null
          discovered_at: string
          match_score: number | null
          match_details: Json | null
          is_new: boolean
          external_id: string | null
        }
        Insert: {
          id?: string
          company_id: string
          title: string
          description: string
          url: string
          location?: string | null
          salary_range?: string | null
          job_type?: string | null
          posted_at?: string | null
          discovered_at?: string
          match_score?: number | null
          match_details?: Json | null
          is_new?: boolean
          external_id?: string | null
        }
        Update: {
          id?: string
          company_id?: string
          title?: string
          description?: string
          url?: string
          location?: string | null
          salary_range?: string | null
          job_type?: string | null
          posted_at?: string | null
          discovered_at?: string
          match_score?: number | null
          match_details?: Json | null
          is_new?: boolean
          external_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "jobs_company_id_fkey"
            columns: ["company_id"]
            referencedRelation: "companies"
            referencedColumns: ["id"]
          }
        ]
      }
      applications: {
        Row: {
          id: string
          user_id: string
          job_id: string
          stage: string
          applied_at: string | null
          source: string | null
          notes: string | null
          resume_version: string | null
          cover_letter: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          job_id: string
          stage?: string
          applied_at?: string | null
          source?: string | null
          notes?: string | null
          resume_version?: string | null
          cover_letter?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          job_id?: string
          stage?: string
          applied_at?: string | null
          source?: string | null
          notes?: string | null
          resume_version?: string | null
          cover_letter?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "applications_user_id_fkey"
            columns: ["user_id"]
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "applications_job_id_fkey"
            columns: ["job_id"]
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          }
        ]
      }
      activities: {
        Row: {
          id: string
          application_id: string
          type: string
          title: string
          description: string | null
          metadata: Json | null
          occurred_at: string
          created_at: string
        }
        Insert: {
          id?: string
          application_id: string
          type: string
          title: string
          description?: string | null
          metadata?: Json | null
          occurred_at?: string
          created_at?: string
        }
        Update: {
          id?: string
          application_id?: string
          type?: string
          title?: string
          description?: string | null
          metadata?: Json | null
          occurred_at?: string
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "activities_application_id_fkey"
            columns: ["application_id"]
            referencedRelation: "applications"
            referencedColumns: ["id"]
          }
        ]
      }
      contacts: {
        Row: {
          id: string
          user_id: string
          company_id: string | null
          name: string
          email: string | null
          linkedin_url: string | null
          title: string | null
          relationship: string | null
          last_contact_at: string | null
          notes: string | null
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          company_id?: string | null
          name: string
          email?: string | null
          linkedin_url?: string | null
          title?: string | null
          relationship?: string | null
          last_contact_at?: string | null
          notes?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          company_id?: string | null
          name?: string
          email?: string | null
          linkedin_url?: string | null
          title?: string | null
          relationship?: string | null
          last_contact_at?: string | null
          notes?: string | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contacts_user_id_fkey"
            columns: ["user_id"]
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_company_id_fkey"
            columns: ["company_id"]
            referencedRelation: "companies"
            referencedColumns: ["id"]
          }
        ]
      }
      follow_ups: {
        Row: {
          id: string
          contact_id: string | null
          application_id: string | null
          due_date: string
          note: string
          is_completed: boolean
          completed_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          contact_id?: string | null
          application_id?: string | null
          due_date: string
          note: string
          is_completed?: boolean
          completed_at?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          contact_id?: string | null
          application_id?: string | null
          due_date?: string
          note?: string
          is_completed?: boolean
          completed_at?: string | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "follow_ups_contact_id_fkey"
            columns: ["contact_id"]
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_ups_application_id_fkey"
            columns: ["application_id"]
            referencedRelation: "applications"
            referencedColumns: ["id"]
          }
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

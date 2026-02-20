export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      digest_tickets: {
        Row: {
          created_at: string
          digest_id: string
          ticket_id: number
        }
        Insert: {
          created_at?: string
          digest_id: string
          ticket_id: number
        }
        Update: {
          created_at?: string
          digest_id?: string
          ticket_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "digest_tickets_digest_id_fkey"
            columns: ["digest_id"]
            isOneToOne: false
            referencedRelation: "digests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "digest_tickets_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "ticket_cache"
            referencedColumns: ["ticket_id"]
          },
        ]
      }
      digests: {
        Row: {
          content_markdown: string
          content_table: Json
          created_at: string
          created_by: string | null
          filters: Json
          id: string
          source: string
          ticket_ids: number[]
          title: string
          updated_at: string
        }
        Insert: {
          content_markdown: string
          content_table?: Json
          created_at?: string
          created_by?: string | null
          filters?: Json
          id?: string
          source?: string
          ticket_ids?: number[]
          title: string
          updated_at?: string
        }
        Update: {
          content_markdown?: string
          content_table?: Json
          created_at?: string
          created_by?: string | null
          filters?: Json
          id?: string
          source?: string
          ticket_ids?: number[]
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      ticket_cache: {
        Row: {
          assignee_email: string | null
          brand: string
          created_at: string
          id: string
          priority: string | null
          raw_payload: Json
          requester_email: string | null
          requester_name: string | null
          status: string
          subject: string
          summary_text: string | null
          summary_updated_at: string | null
          synced_at: string
          ticket_id: number
          ticket_url: string | null
          updated_at: string
          zendesk_created_at: string | null
          zendesk_updated_at: string | null
        }
        Insert: {
          assignee_email?: string | null
          brand?: string
          created_at?: string
          id?: string
          priority?: string | null
          raw_payload?: Json
          requester_email?: string | null
          requester_name?: string | null
          status?: string
          subject?: string
          summary_text?: string | null
          summary_updated_at?: string | null
          synced_at?: string
          ticket_id: number
          ticket_url?: string | null
          updated_at?: string
          zendesk_created_at?: string | null
          zendesk_updated_at?: string | null
        }
        Update: {
          assignee_email?: string | null
          brand?: string
          created_at?: string
          id?: string
          priority?: string | null
          raw_payload?: Json
          requester_email?: string | null
          requester_name?: string | null
          status?: string
          subject?: string
          summary_text?: string | null
          summary_updated_at?: string | null
          synced_at?: string
          ticket_id?: number
          ticket_url?: string | null
          updated_at?: string
          zendesk_created_at?: string | null
          zendesk_updated_at?: string | null
        }
        Relationships: []
      }
      ticket_summaries: {
        Row: {
          created_at: string
          id: string
          key_actions: Json
          model: string | null
          next_steps: Json
          summary_text: string
          ticket_id: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          key_actions?: Json
          model?: string | null
          next_steps?: Json
          summary_text: string
          ticket_id: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          key_actions?: Json
          model?: string | null
          next_steps?: Json
          summary_text?: string
          ticket_id?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ticket_summaries_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: true
            referencedRelation: "ticket_cache"
            referencedColumns: ["ticket_id"]
          },
        ]
      }
      time_off_requests: {
        Row: {
          approval_token: string
          created_at: string
          employee_email: string
          employee_name: string
          end_date: string
          id: string
          reason: string
          start_date: string
          status: string
          updated_at: string
        }
        Insert: {
          approval_token?: string
          created_at?: string
          employee_email: string
          employee_name: string
          end_date: string
          id?: string
          reason: string
          start_date: string
          status?: string
          updated_at?: string
        }
        Update: {
          approval_token?: string
          created_at?: string
          employee_email?: string
          employee_name?: string
          end_date?: string
          id?: string
          reason?: string
          start_date?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      zendesk_sync_runs: {
        Row: {
          created_at: string
          cursor: number | null
          error_message: string | null
          finished_at: string | null
          id: string
          started_at: string
          status: string
          tickets_fetched: number
          tickets_upserted: number
        }
        Insert: {
          created_at?: string
          cursor?: number | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          started_at?: string
          status: string
          tickets_fetched?: number
          tickets_upserted?: number
        }
        Update: {
          created_at?: string
          cursor?: number | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          started_at?: string
          status?: string
          tickets_fetched?: number
          tickets_upserted?: number
        }
        Relationships: []
      }
      zendesk_tickets: {
        Row: {
          assignee_email: string | null
          brand: string
          created_at: string
          id: string
          priority: string | null
          raw_payload: Json
          requester_email: string | null
          status: string
          subject: string
          synced_at: string
          ticket_id: number
          updated_at: string
          zendesk_created_at: string | null
          zendesk_updated_at: string | null
        }
        Insert: {
          assignee_email?: string | null
          brand?: string
          created_at?: string
          id?: string
          priority?: string | null
          raw_payload?: Json
          requester_email?: string | null
          status?: string
          subject?: string
          synced_at?: string
          ticket_id: number
          updated_at?: string
          zendesk_created_at?: string | null
          zendesk_updated_at?: string | null
        }
        Update: {
          assignee_email?: string | null
          brand?: string
          created_at?: string
          id?: string
          priority?: string | null
          raw_payload?: Json
          requester_email?: string | null
          status?: string
          subject?: string
          synced_at?: string
          ticket_id?: number
          updated_at?: string
          zendesk_created_at?: string | null
          zendesk_updated_at?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      is_virtuix_user: {
        Args: Record<PropertyKey, never>
        Returns: boolean
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

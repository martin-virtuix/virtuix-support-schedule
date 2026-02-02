import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { Resend } from "https://esm.sh/resend@2.0.0";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface ApprovalNotification {
  employeeEmail: string;
  employeeName: string;
  startDate: string;
  endDate: string;
  status: "approved" | "denied";
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const {
      employeeEmail,
      employeeName,
      startDate,
      endDate,
      status,
    }: ApprovalNotification = await req.json();

    const isApproved = status === "approved";
    const statusColor = isApproved ? "#22c55e" : "#ef4444";
    const statusText = isApproved ? "Approved" : "Denied";
    const statusEmoji = isApproved ? "✅" : "❌";

    const emailResponse = await resend.emails.send({
      from: "Time Off Requests <noreply@resend.dev>",
      to: [employeeEmail],
      subject: `Your Time Off Request has been ${statusText}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0f172a; color: #e5e7eb; padding: 40px 20px; margin: 0;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #020617; border-radius: 12px; padding: 32px; box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4);">
            <div style="text-align: center; margin-bottom: 24px;">
              <span style="font-size: 48px;">${statusEmoji}</span>
            </div>
            
            <h1 style="color: ${statusColor}; margin: 0 0 24px 0; font-size: 24px; text-align: center;">
              Time Off Request ${statusText}
            </h1>
            
            <p style="margin: 0 0 24px 0; text-align: center;">
              Hi ${employeeName},
            </p>
            
            <p style="margin: 0 0 24px 0; text-align: center;">
              Your time off request for <strong>${startDate}</strong> to <strong>${endDate}</strong> has been <strong style="color: ${statusColor};">${status}</strong>.
            </p>
            
            ${isApproved ? `
              <div style="background-color: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 8px; padding: 16px; text-align: center;">
                <p style="margin: 0; color: #22c55e;">
                  Enjoy your time off! 🎉
                </p>
              </div>
            ` : `
              <div style="background-color: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 8px; padding: 16px; text-align: center;">
                <p style="margin: 0; color: #ef4444;">
                  Please contact your manager if you have any questions.
                </p>
              </div>
            `}
            
            <p style="margin: 24px 0 0 0; color: #6b7280; font-size: 14px; text-align: center;">
              This is an automated message from the Omni Arena Support Schedule system.
            </p>
          </div>
        </body>
        </html>
      `,
    });

    console.log("Approval notification email sent:", emailResponse);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error: any) {
    console.error("Error sending approval notification:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  }
};

serve(handler);

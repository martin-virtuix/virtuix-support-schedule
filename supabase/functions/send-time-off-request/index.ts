import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { Resend } from "https://esm.sh/resend@2.0.0";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));
const managerEmail = Deno.env.get("MANAGER_EMAIL");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface TimeOffRequest {
  requestId: string;
  employeeName: string;
  employeeEmail: string;
  startDate: string;
  endDate: string;
  reason: string;
  approvalToken: string;
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const {
      requestId,
      employeeName,
      employeeEmail,
      startDate,
      endDate,
      reason,
      approvalToken,
    }: TimeOffRequest = await req.json();

    if (!managerEmail) {
      throw new Error("Manager email not configured");
    }

    const baseUrl = req.headers.get("origin") || "https://your-app.lovable.app";
    const approveUrl = `${baseUrl}/approve?token=${approvalToken}&action=approve`;
    const denyUrl = `${baseUrl}/approve?token=${approvalToken}&action=deny`;
    const reviewUrl = `${baseUrl}/approve?token=${approvalToken}`;

    const emailResponse = await resend.emails.send({
      from: "Time Off Requests <noreply@resend.dev>",
      to: [managerEmail],
      subject: `Time Off Request from ${employeeName}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0f172a; color: #e5e7eb; padding: 40px 20px; margin: 0;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #020617; border-radius: 12px; padding: 32px; box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4);">
            <h1 style="color: #7fdb4a; margin: 0 0 24px 0; font-size: 24px;">New Time Off Request</h1>
            
            <div style="background-color: #111827; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
              <p style="margin: 0 0 12px 0;"><strong style="color: #9ca3af;">Employee:</strong> ${employeeName}</p>
              <p style="margin: 0 0 12px 0;"><strong style="color: #9ca3af;">Email:</strong> ${employeeEmail}</p>
              <p style="margin: 0 0 12px 0;"><strong style="color: #9ca3af;">Start Date:</strong> ${startDate}</p>
              <p style="margin: 0 0 12px 0;"><strong style="color: #9ca3af;">End Date:</strong> ${endDate}</p>
              <p style="margin: 0;"><strong style="color: #9ca3af;">Reason:</strong> ${reason}</p>
            </div>
            
            <p style="margin: 0 0 20px 0; color: #9ca3af;">Click one of the buttons below to respond:</p>
            
            <div style="display: flex; gap: 12px; margin-bottom: 24px;">
              <a href="${approveUrl}" style="display: inline-block; background-color: #22c55e; color: #020617; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">✓ Approve</a>
              <a href="${denyUrl}" style="display: inline-block; background-color: #ef4444; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">✗ Deny</a>
            </div>
            
            <p style="margin: 0; color: #6b7280; font-size: 14px;">
              Or <a href="${reviewUrl}" style="color: #7fdb4a;">review the full request</a> before deciding.
            </p>
          </div>
        </body>
        </html>
      `,
    });

    console.log("Time off request email sent:", emailResponse);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error: any) {
    console.error("Error sending time off request email:", error);
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

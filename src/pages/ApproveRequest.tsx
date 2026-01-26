import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { Check, X, Loader2, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import omniLogo from "@/assets/omniarena-logo.png";

export default function ApproveRequest() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  
  const [isLoading, setIsLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [request, setRequest] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const token = searchParams.get("token");
  const action = searchParams.get("action");

  useEffect(() => {
    async function fetchRequest() {
      if (!token) {
        setError("Invalid approval link");
        setIsLoading(false);
        return;
      }

      const { data, error } = await supabase
        .from("time_off_requests")
        .select("*")
        .eq("approval_token", token)
        .maybeSingle();

      if (error || !data) {
        setError("Request not found or already processed");
        setIsLoading(false);
        return;
      }

      setRequest(data);
      setIsLoading(false);

      // Auto-process if action is provided in URL
      if (action === "approve" || action === "deny") {
        handleDecision(action === "approve" ? "approved" : "denied", data);
      }
    }

    fetchRequest();
  }, [token, action]);

  async function handleDecision(status: "approved" | "denied", requestData = request) {
    if (!requestData) return;
    
    setIsProcessing(true);
    try {
      // Update request status
      const { error: updateError } = await supabase
        .from("time_off_requests")
        .update({ status })
        .eq("id", requestData.id);

      if (updateError) throw updateError;

      // Send confirmation email to employee
      const { error: emailError } = await supabase.functions.invoke("send-approval-notification", {
        body: {
          employeeEmail: requestData.employee_email,
          employeeName: requestData.employee_name,
          startDate: requestData.start_date,
          endDate: requestData.end_date,
          status,
        },
      });

      if (emailError) throw emailError;

      toast({
        title: status === "approved" ? "Request Approved" : "Request Denied",
        description: `${requestData.employee_name} has been notified via email.`,
      });

      setRequest({ ...requestData, status });
    } catch (error) {
      console.error("Error processing request:", error);
      toast({
        title: "Error",
        description: "Failed to process the request. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsProcessing(false);
    }
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="glass-card rounded-xl p-8 text-center max-w-md">
          <X className="w-12 h-12 text-destructive mx-auto mb-4" />
          <h1 className="text-xl font-bold mb-2">Error</h1>
          <p className="text-muted-foreground mb-6">{error}</p>
          <Button onClick={() => navigate("/")} variant="outline">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Schedule
          </Button>
        </div>
      </div>
    );
  }

  const isAlreadyProcessed = request?.status !== "pending";

  return (
    <div className="min-h-screen bg-background">
      <div className="container max-w-lg py-8 px-4">
        <div className="text-center mb-8">
          <img
            src={omniLogo}
            alt="Omni Arena"
            className="h-8 mx-auto mb-4 opacity-80"
          />
          <h1 className="text-2xl font-bold">Time Off Request</h1>
        </div>

        <div className="glass-card rounded-xl p-6 space-y-6">
          <div className="space-y-4">
            <div>
              <span className="text-sm text-muted-foreground">Employee</span>
              <p className="font-medium">{request?.employee_name}</p>
            </div>
            <div>
              <span className="text-sm text-muted-foreground">Email</span>
              <p className="font-medium">{request?.employee_email}</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="text-sm text-muted-foreground">Start Date</span>
                <p className="font-medium">{request?.start_date}</p>
              </div>
              <div>
                <span className="text-sm text-muted-foreground">End Date</span>
                <p className="font-medium">{request?.end_date}</p>
              </div>
            </div>
            <div>
              <span className="text-sm text-muted-foreground">Reason</span>
              <p className="font-medium">{request?.reason}</p>
            </div>
          </div>

          {isAlreadyProcessed ? (
            <div className={`p-4 rounded-lg text-center ${
              request?.status === "approved" 
                ? "bg-success/10 text-success" 
                : "bg-destructive/10 text-destructive"
            }`}>
              <p className="font-semibold capitalize">
                This request has been {request?.status}
              </p>
            </div>
          ) : (
            <div className="flex gap-3">
              <Button
                onClick={() => handleDecision("denied")}
                variant="outline"
                className="flex-1 gap-2"
                disabled={isProcessing}
              >
                <X className="w-4 h-4" />
                Deny
              </Button>
              <Button
                onClick={() => handleDecision("approved")}
                className="flex-1 gap-2"
                disabled={isProcessing}
              >
                {isProcessing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Check className="w-4 h-4" />
                )}
                Approve
              </Button>
            </div>
          )}
        </div>

        <div className="text-center mt-6">
          <Button onClick={() => navigate("/")} variant="ghost" className="gap-2">
            <ArrowLeft className="w-4 h-4" />
            Back to Schedule
          </Button>
        </div>
      </div>
    </div>
  );
}

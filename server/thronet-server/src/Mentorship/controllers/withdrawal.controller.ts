import { Request, Response } from "express";
import { withdrawalService } from "../services/withdrawal.service";

export class WithdrawalController {
  // GET /mentorship/withdrawal/:mentorId
  async getMethods(req: Request, res: Response) {
    try {
      const { mentorId } = req.params;
      const methods = await withdrawalService.getMethods(mentorId);
      res.status(200).json({ success: true, data: methods });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // POST /mentorship/withdrawal/:mentorId
  async addMethod(req: Request, res: Response) {
    try {
      const { mentorId } = req.params;
      const payload = req.body;

      // Basic validation
      if (!payload.type || !["bank", "upi"].includes(payload.type)) {
        return res.status(400).json({ success: false, message: "Invalid type. Must be 'bank' or 'upi'" });
      }

      if (payload.type === "bank") {
        const required = ["bankName", "accountHolderName", "accountNumber", "ifscCode", "accountType"];
        for (const field of required) {
          if (!payload[field]) {
            return res.status(400).json({ success: false, message: `${field} is required for bank account` });
          }
        }
        // Mask account number before saving — store last 4 digits display separately
        // Full number stored for actual withdrawals
      }

      if (payload.type === "upi") {
        if (!payload.upiId) {
          return res.status(400).json({ success: false, message: "upiId is required for UPI" });
        }
        // Basic UPI format check
        if (!payload.upiId.includes("@")) {
          return res.status(400).json({ success: false, message: "Invalid UPI ID format" });
        }
      }

      const method = await withdrawalService.addMethod(mentorId, payload);
      res.status(201).json({ success: true, data: method, message: "Method added successfully" });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // PATCH /mentorship/withdrawal/:mentorId/:methodId/default
  async setDefault(req: Request, res: Response) {
    try {
      const { mentorId, methodId } = req.params;
      const method = await withdrawalService.setDefault(mentorId, methodId);
      res.status(200).json({ success: true, data: method, message: "Default updated" });
    } catch (error: any) {
      res.status(404).json({ success: false, message: error.message });
    }
  }

  // DELETE /mentorship/withdrawal/:mentorId/:methodId
  async deleteMethod(req: Request, res: Response) {
    try {
      const { mentorId, methodId } = req.params;
      await withdrawalService.deleteMethod(mentorId, methodId);
      res.status(200).json({ success: true, message: "Method deleted successfully" });
    } catch (error: any) {
      res.status(404).json({ success: false, message: error.message });
    }
  }
}

export const withdrawalController = new WithdrawalController();
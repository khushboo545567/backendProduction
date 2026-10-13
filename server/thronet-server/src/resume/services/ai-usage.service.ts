import mongoose from "mongoose";
import { AIUsage } from "../models/ai-usage.model";

type AIFeature =
  | "generate-summary"
  | "rewrite-experience"
  | "suggest-skills"
  | "generate-project"
  | "ats-analysis"
  | "generate-experience"
  | "generate-project-description"
  | "generate-coursework"
  | "generate-custom-section"
  | "generate-internship"
  | "generate-resume"
  | "generate-cover-letter"
  | "regenerate-cover-letter";

export const trackAIUsage = async (
  userId: string,
  feature: AIFeature,
  tokensUsed = 0,
) => {
  await AIUsage.create({
    userId: new mongoose.Types.ObjectId(userId),
    feature,
    tokensUsed,
  });
};

import { User } from "../../models/user.model";
import { Resume } from "../../models/resume.model";
import { ResumeAnalysis } from "../../models/resume-analysis.model";
import { AIUsage } from "../../models/ai-usage.model";
import { ResumeAnalytics } from "../../models/resume-analytics.model";
import mongoose from "mongoose";

export async function getDashboardStats() {
  const [
    totalUsers,
    totalResumes,
    totalSharedResumes,
    totalATSAnalyses,
    totalAIRequests,
    analytics,
  ] = await Promise.all([
    User.countDocuments(),

    Resume.countDocuments(),

    Resume.countDocuments({
      isPublic: true,
    }),

    ResumeAnalysis.countDocuments(),

    AIUsage.countDocuments(),

    ResumeAnalytics.aggregate([
      {
        $group: {
          _id: null,

          downloads: {
            $sum: "$downloads",
          },

          views: {
            $sum: "$views",
          },

          shares: {
            $sum: "$shares",
          },
        },
      },
    ]),
  ]);

  return {
    totalUsers,

    totalResumes,

    totalSharedResumes,

    totalATSAnalyses,

    totalAIRequests,

    totalDownloads:
      analytics[0]?.downloads ?? 0,

    totalViews:
      analytics[0]?.views ?? 0,

    totalShares:
      analytics[0]?.shares ?? 0,
  };
}


 

export async function getUsers(
  page: number,
  limit: number,
  search: string
) {
  const filter = search
    ? {
        $or: [
          {
            name: {
              $regex: search,
              $options: "i",
            },
          },
          {
            email: {
              $regex: search,
              $options: "i",
            },
          },
        ],
      }
    : {};

  const users = await User.find(filter)
    .select("-password")
    .skip((page - 1) * limit)
    .limit(limit)
    .sort({
      createdAt: -1,
    });

  const total =
    await User.countDocuments(filter);

  return {
    users,
    total,
    page,
    totalPages: Math.ceil(
      total / limit
    ),
  };
}


export async function updateUserStatus(
  id: string,
  status: string
) {
  return User.findByIdAndUpdate(
    id,
    {
      status,
    },
    {
      new: true,
    }
  ).select("-password");
}


import { ApiError } from "../../utils/ApiError";

export async function deleteUser(
  id: string
) {
  const user = await User.findById(id);

  if (!user) {
    throw new ApiError(
      404,
      "User not found"
    );
  }

  // Admin delete not allowed
  if (user.role === "admin") {
    throw new ApiError(
      403,
      "Admin account cannot be deleted"
    );
  }

  return User.findByIdAndDelete(id);
}



 

export async function getUserDetails(
  userId: string
) {
  const user = await User.findById(userId)
    .select("-password")
    .lean();

  if (!user) {
    throw new Error("User not found");
  }

  const [
    resumes,
    aiRequests,
    atsAnalyses,
  ] = await Promise.all([
    Resume.countDocuments({
  userId: new mongoose.Types.ObjectId(userId),
}),

    AIUsage.countDocuments({
      userId,
    }),

    ResumeAnalysis.countDocuments({
      userId,
    }),
  ]);

  return {
    user,
    stats: {
      resumes,
      aiRequests,
      atsAnalyses,
    },
  };
}
// src/Job-Service/enums/NotificationType.enum.ts
export enum NotificationType {
  APPLICATION_SUBMITTED = 'application_submitted',
  APPLICATION_STATUS_UPDATED = 'application_status_updated',
  JOB_RECOMMENDATION = 'job_recommendation',
  NEW_JOB_POSTED = 'new_job_posted',
}

export enum NotificationChannel {
  EMAIL = 'email',
  SMS = 'sms',
  WHATSAPP = 'whatsapp',
  PUSH = 'push',
  IN_APP = 'in_app',
}

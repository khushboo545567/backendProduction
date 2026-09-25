export interface CreateCommunityEventDTO {
  title: string;
  description?: string;
  date: string; // ISO date string from client
  type: 'meetup' | 'webinar' | 'workshop' | 'networking';
  resourceLink?: string;
  capacity?: number;
}

export interface UpdateCommunityEventDTO {
  title?: string;
  description?: string;
  date?: string;
  type?: 'meetup' | 'webinar' | 'workshop' | 'networking';
  resourceLink?: string;
  capacity?: number;
}

export interface CommunityEventListQuery {
  type?: string;
  upcoming?: boolean;
  page?: number;
  limit?: number;
}
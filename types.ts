export enum TutorPersona {
  FRIENDLY = 'friendly',
  PROFESSIONAL = 'professional',
  STRICT = 'strict'
}

export interface Scenario {
  id: string;
  title: string;
  description: string;
  emoji: string;
  systemInstruction: string;
  difficulty: 'Beginner' | 'Intermediate' | 'Advanced';
}

export interface TranscriptItem {
  id: string;
  speaker: 'user' | 'model';
  text: string;
  timestamp: Date;
}

export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  ERROR = 'error'
}
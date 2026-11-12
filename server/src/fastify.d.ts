declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
    auth?: {
      sessionId: string;
      userId: string;
      email: string;
      role: 'superadmin' | 'admin' | 'user';
      mfaPassed: boolean;
      impersonatedBy?: string | null;
      impersonatorEmail?: string | null;
      mobileDeviceId?: string | null;
    };
    agent?: {
      routerId: string;
      ownerId: string;
      product: string;
      status: string;
      agentVersion: string | null;
    };
  }
}

export {};

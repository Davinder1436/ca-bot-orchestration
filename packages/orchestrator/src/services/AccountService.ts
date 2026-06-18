import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

export const CreateAccountSchema = z.object({
  email: z.string().email(),
  pin: z.string().length(6),
  country: z.enum(["CA", "US"]).default("CA"),
  jobIds: z.array(z.string()).default([]),
  proxyId: z.string().optional(),
  notes: z.string().optional(),
});

export const UpdateAccountSchema = CreateAccountSchema.partial().extend({
  status: z.enum(["IDLE", "RUNNING", "PAUSED", "BANNED", "ERROR"]).optional(),
});

export class AccountService {
  constructor(private db: PrismaClient) {}

  async list() {
    return this.db.account.findMany({
      include: { proxy: true, _count: { select: { captures: true } } },
      orderBy: { createdAt: "desc" },
    });
  }

  async get(id: string) {
    return this.db.account.findUniqueOrThrow({
      where: { id },
      include: { proxy: true, captures: { orderBy: { capturedAt: "desc" }, take: 10 } },
    });
  }

  async create(data: z.infer<typeof CreateAccountSchema>) {
    return this.db.account.create({ data });
  }

  async update(id: string, data: z.infer<typeof UpdateAccountSchema>) {
    return this.db.account.update({ where: { id }, data });
  }

  async delete(id: string) {
    return this.db.account.delete({ where: { id } });
  }
}

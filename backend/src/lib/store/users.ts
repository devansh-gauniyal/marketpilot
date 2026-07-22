import type { User } from "./types";
import { getJson, listJson, putJson } from "./sqlite";

export const DEFAULT_USER_ID = "user_devansh";

const defaultUser: User = {
  id: DEFAULT_USER_ID,
  email: "devansh.local@marketpilot.dev",
  name: "Devansh",
  createdAt: new Date().toISOString(),
};

if (!getJson<User>("users", DEFAULT_USER_ID)) {
  putJson("users", DEFAULT_USER_ID, defaultUser, {
    createdAt: defaultUser.createdAt,
  });
}

export const usersStore = {
  create(input: Omit<User, "id" | "createdAt"> & { id?: string }): User {
    const user: User = {
      id: input.id ?? crypto.randomUUID(),
      email: input.email,
      name: input.name,
      createdAt: new Date().toISOString(),
    };
    return putJson("users", user.id, user, {
      createdAt: user.createdAt,
    });
  },

  get(id: string): User | undefined {
    return getJson<User>("users", id);
  },

  getDefault(): User {
    return this.get(DEFAULT_USER_ID) ?? defaultUser;
  },

  list(): User[] {
    return listJson<User>("users");
  },
};

import { pgTable, serial, text, boolean, integer, bigint, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  telegramId: bigint("telegram_id", { mode: "bigint" }).notNull().unique(),
  firstName: text("first_name").notNull(),
  username: text("username"),
  role: text("role").notNull().default("user"),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const modelsTable = pgTable("models", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  coverUrl: text("cover_url").notNull(),
  avatarUrl: text("avatar_url").notNull(),
  bio: text("bio"),
  isVerified: boolean("is_verified").notNull().default(false),
  followerCount: integer("follower_count").notNull().default(0),
  likeCount: integer("like_count").notNull().default(0),
  photoCount: integer("photo_count"),
  videoCount: integer("video_count").notNull().default(0),
  isOnline: boolean("is_online").notNull().default(false),
  viewerCount: integer("viewer_count"),
  tags: text("tags").array().notNull().default([]),
  photos: text("photos").array().notNull().default([]),
  isFeatured: boolean("is_featured").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const messagesTable = pgTable("messages", {
  id: serial("id").primaryKey(),
  modelSlug: text("model_slug").notNull(),
  userId: integer("user_id").notNull(),
  content: text("content").notNull(),
  fromUser: boolean("from_user").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const subdomainsTable = pgTable("subdomains", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  modelId: integer("model_id").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  customTitle: text("custom_title").notNull(),
  customDescription: text("custom_description"),
  customColor: text("custom_color"),
  customLogoUrl: text("custom_logo_url"),
  customBannerUrl: text("custom_banner_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertModelSchema = createInsertSchema(modelsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertMessageSchema = createInsertSchema(messagesTable).omit({ id: true, createdAt: true });
export const insertSubdomainSchema = createInsertSchema(subdomainsTable).omit({ id: true, createdAt: true, updatedAt: true });

export type User = typeof usersTable.$inferSelect;
export type Model = typeof modelsTable.$inferSelect;
export type Message = typeof messagesTable.$inferSelect;
export type Subdomain = typeof subdomainsTable.$inferSelect;

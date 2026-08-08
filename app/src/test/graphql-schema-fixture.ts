/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one GraphQL schema every GraphQL test builds on.
 *
 * The 2026-08-08 sweep found each GraphQL test file hand-rolling a two-line
 * schema (`type Query { ping: String }`), which meant no test anywhere exercised
 * an enum, an input object, an interface, a union, a subscription or a
 * deprecation - exactly the shapes an explorer, a completion list and a
 * variables JSON Schema have to get right.
 *
 * **It is SDL, not a checked-in introspection dump.** The dump is what consumers
 * want (`fixtureIntrospection()` produces it on demand, byte-identical to what a
 * real endpoint returns, because `introspectionFromSchema` is the same code path
 * a server runs), but a 100KB JSON blob in the tree is unreadable and drifts
 * silently. One SDL string is the source; both other shapes are derived from it,
 * so they cannot disagree.
 */

import { buildSchema, introspectionFromSchema, type GraphQLSchema } from "graphql";
import type { IntrospectionQuery } from "graphql";

/** Every type kind the renderers have to handle, in one small schema. */
export const FIXTURE_SDL = `
"""Anything with a stable id."""
interface Node {
  id: ID!
}

"""How search results are ordered."""
enum Ranking {
  RELEVANCE
  RECENCY
  LEGACY @deprecated(reason: "Use RELEVANCE.")
}

input PostFilter {
  authorId: ID
  ranking: Ranking = RELEVANCE
  tags: [String!]
}

input CreatePostInput {
  title: String!
  body: String
  tags: [String!]
}

type User implements Node {
  id: ID!
  name: String!
  """The handle shown beside the name."""
  handle: String
  nickname: String @deprecated(reason: "Use handle.")
  posts(first: Int = 10, filter: PostFilter): [Post!]!
}

type Post implements Node {
  id: ID!
  title: String!
  body: String
  author: User!
}

union SearchResult = User | Post

type Query {
  node(id: ID!): Node
  user(id: ID!): User
  """Search across users and posts."""
  search(term: String!, ranking: Ranking = RELEVANCE): [SearchResult!]!
  legacySearch(term: String!): [SearchResult!]! @deprecated(reason: "Use search.")
}

type Mutation {
  createPost(input: CreatePostInput!): Post
  deletePost(id: ID!): Boolean
}

type Subscription {
  postAdded: Post
}
`;

/** The fixture as a executable-free schema object, for validation and completion. */
export function fixtureSchema(): GraphQLSchema {
	return buildSchema(FIXTURE_SDL);
}

/** The fixture as the introspection result an endpoint would answer with. */
export function fixtureIntrospection(): IntrospectionQuery {
	return introspectionFromSchema(fixtureSchema());
}

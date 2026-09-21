import * as assert from "node:assert/strict";
import { test } from "node:test";

import { generatedFiles, goLinksFor, goNameOf, protoPackage } from "./protobuf";

// vscode.SymbolKind, as `buf lsp serve` reports a .proto.
const CLASS = 4; // message
const ENUM = 9;
const INTERFACE = 10; // service
const METHOD = 5; // rpc

test("the package clause is read off the file", () => {
  assert.equal(protoPackage("syntax = \"proto3\";\n\npackage greet.v1;\n"), "greet.v1");
  assert.equal(protoPackage("package greet;\n"), "greet");
  assert.equal(protoPackage("syntax = \"proto3\";\n"), undefined);
  // A package named inside a comment is not the file's package.
  assert.equal(protoPackage("// package wrong.v1;\npackage right.v1;\n"), "right.v1");
});

test("protoc drops the proto package and joins the rest with an underscore", () => {
  assert.equal(goNameOf("greet.v1.HelloRequest", "greet.v1"), "HelloRequest");
  assert.equal(goNameOf("greet.v1.HelloRequest.Nested", "greet.v1"), "HelloRequest_Nested");
  // No package clause, so every segment is part of the declaration's path.
  assert.equal(goNameOf("HelloRequest", undefined), "HelloRequest");
  // A name that does not start with the package is left alone rather than cut
  // at a length that would take real characters off it.
  assert.equal(goNameOf("other.v1.Thing", "greet.v1"), "other_v1_Thing");
});

test("a service is two Go interfaces and neither is named after it", () => {
  // The pair anyone reading a `service` block is looking for: the one a caller
  // holds and the one an implementation satisfies.
  assert.deepEqual(goLinksFor("greet.v1.Greeter", INTERFACE, "greet.v1"), [
    { label: "go server", name: "GreeterServer" },
    { label: "go client", name: "GreeterClient" },
  ]);
});

test("a message and an enum are one type each", () => {
  assert.deepEqual(goLinksFor("greet.v1.HelloReply", CLASS, "greet.v1"), [
    { label: "go type", name: "HelloReply" },
  ]);
  assert.deepEqual(goLinksFor("greet.v1.Tone", ENUM, "greet.v1"), [
    { label: "go type", name: "Tone" },
  ]);
});

test("an rpc gets no link of its own", () => {
  // It is a method on both generated interfaces, so a lens on it would have to
  // pick one; the service above it already links to both, and the reference
  // lens already says who calls it.
  assert.deepEqual(goLinksFor("greet.v1.Greeter.SayHello", METHOD, "greet.v1"), []);
});

test("the generated file keeps the proto's stem", () => {
  assert.deepEqual(generatedFiles("/w/proto/greet/v1/greet.proto"), [
    "greet.pb.go",
    "greet_grpc.pb.go",
  ]);
  assert.deepEqual(generatedFiles("greet.proto"), ["greet.pb.go", "greet_grpc.pb.go"]);
});

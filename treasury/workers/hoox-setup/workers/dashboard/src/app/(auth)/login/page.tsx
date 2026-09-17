"use client";

/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, Loader2 } from "lucide-react";
import { Key, Lock, Shield, User } from "reicon-react";

import { AmbientBackground } from "@/components/dashboard/ambient-background";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";

export default function LoginPage() {
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (response.ok) {
        router.push("/dashboard");
        router.refresh();
      } else {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(body?.error || "Invalid credentials");
      }
    } catch {
      setError("Login failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const hasError = Boolean(error);

  return (
    <AmbientBackground>
      <div className="flex flex-1 items-center justify-center overflow-hidden p-4">
        <motion.div
          initial={reduceMotion ? false : { opacity: 0, y: 16 }}
          animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: "easeOut" }}
          className="relative z-10 w-full max-w-md"
        >
          <Card className="overflow-hidden rounded-xl border-border/80 bg-card/85 shadow-2xl backdrop-blur-xl">
            <div
              aria-hidden="true"
              className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/60 to-transparent"
            />

            <CardHeader className="flex flex-col gap-3 pb-6 text-center">
              <motion.div
                initial={reduceMotion ? false : { scale: 0.85, opacity: 0 }}
                animate={reduceMotion ? undefined : { scale: 1, opacity: 1 }}
                transition={{ delay: 0.12, type: "spring", stiffness: 220 }}
                className="mx-auto mb-1 flex size-14 items-center justify-center"
              >
                {/* Official HOOX mark (brand/svg/mark-orange-transparent) */}
                <img
                  src="/hoox-logo.svg"
                  alt="Hoox"
                  width={56}
                  height={56}
                  className="size-14 shrink-0"
                  decoding="async"
                />
              </motion.div>
              <CardTitle className="bg-gradient-to-br from-foreground to-muted-foreground bg-clip-text text-3xl font-bold tracking-tight text-transparent">
                Hoox Gateway
              </CardTitle>
              <CardDescription className="font-medium text-muted-foreground">
                Authenticate to access the command center
              </CardDescription>
            </CardHeader>

            <CardContent>
              <form
                onSubmit={handleSubmit}
                className="flex flex-col gap-5"
                noValidate
                aria-busy={loading || undefined}
              >
                <FieldGroup
                  data-invalid={hasError || undefined}
                  data-disabled={loading || undefined}
                  className="flex flex-col gap-5"
                >
                  {error && (
                    <motion.div
                      initial={reduceMotion ? false : { opacity: 0, height: 0 }}
                      animate={
                        reduceMotion
                          ? undefined
                          : { opacity: 1, height: "auto" }
                      }
                    >
                      <Alert variant="destructive" role="alert">
                        <Shield />
                        <AlertDescription>{error}</AlertDescription>
                      </Alert>
                    </motion.div>
                  )}

                  <Field data-disabled={loading || undefined}>
                    <FieldLabel
                      htmlFor="username"
                      className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                    >
                      Username
                    </FieldLabel>
                    <InputGroup>
                      <InputGroupAddon>
                        <User aria-hidden="true" />
                      </InputGroupAddon>
                      <InputGroupInput
                        id="username"
                        type="text"
                        name="username"
                        placeholder="admin"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        autoComplete="username"
                        autoFocus
                        aria-invalid={hasError || undefined}
                        aria-describedby={hasError ? "login-error" : undefined}
                        disabled={loading}
                        required
                      />
                    </InputGroup>
                  </Field>

                  <Field data-disabled={loading || undefined}>
                    <FieldLabel
                      htmlFor="password"
                      className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                    >
                      Password
                    </FieldLabel>
                    <InputGroup>
                      <InputGroupAddon>
                        <Lock aria-hidden="true" />
                      </InputGroupAddon>
                      <InputGroupInput
                        id="password"
                        type="password"
                        name="password"
                        placeholder="••••••••"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="current-password"
                        aria-invalid={hasError || undefined}
                        disabled={loading}
                        required
                      />
                    </InputGroup>
                  </Field>

                  {hasError ? (
                    <p id="login-error" className="sr-only">
                      {error}
                    </p>
                  ) : null}

                  <Field className="pt-1">
                    <Button
                      type="submit"
                      className="h-11 w-full"
                      disabled={loading || !username || !password}
                      aria-busy={loading || undefined}
                    >
                      {loading ? (
                        <>
                          <Loader2
                            className="animate-spin"
                            aria-hidden="true"
                          />
                          Authenticating…
                        </>
                      ) : (
                        <>
                          Access System
                          <ArrowRight
                            className="opacity-70"
                            aria-hidden="true"
                          />
                        </>
                      )}
                    </Button>
                  </Field>
                </FieldGroup>
              </form>
            </CardContent>
          </Card>

          <div className="mt-6 flex flex-col items-center justify-center gap-2">
            <div className="flex flex-wrap items-center justify-center gap-2 text-muted-foreground">
              <div className="flex items-center gap-1 rounded border border-border bg-muted/30 px-2 py-1 font-mono text-[10px] uppercase tracking-widest">
                <Shield className="size-3 text-success" aria-hidden="true" />
                <span>Zero Trust</span>
              </div>
              <div className="flex items-center gap-1 rounded border border-border bg-muted/30 px-2 py-1 font-mono text-[10px] uppercase tracking-widest">
                <Lock className="size-3 text-accent" aria-hidden="true" />
                <span>Edge Auth</span>
              </div>
              <div className="flex items-center gap-1 rounded border border-border bg-muted/30 px-2 py-1 font-mono text-[10px] uppercase tracking-widest">
                <Key className="size-3 text-accent" aria-hidden="true" />
                <span>Session Cookie</span>
              </div>
            </div>
            <p className="text-center font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Secured by Cloudflare Infrastructure
            </p>
          </div>
        </motion.div>
      </div>
    </AmbientBackground>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { EmailAndNotesFields, focusFirstError, emptyMemberForm, formToPayload, IdentityFields, type MemberFormErrors, type MemberFormState, PlanFields, serverErrors } from './member-form';

export function NewMemberPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: queryKeys.workspaceSettings, queryFn: api.workspaceSettings });
  const [form, setForm] = React.useState<MemberFormState>(() => emptyMemberForm(undefined));
  const [errors, setErrors] = React.useState<MemberFormErrors>({});
  React.useEffect(() => {
    if (settings.data) setForm((f) => ({ ...f, currency: settings.data.memberDefaults.currency }));
  }, [settings.data]);

  const create = useMutation({
    mutationFn: api.createMember,
    onSuccess: (member) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.members });
      queryClient.setQueryData(queryKeys.member(member.id), member);
      navigate(`/members/${member.id}`, { replace: true });
    },
    onError: (err) => {
      const errs = serverErrors(err);
      setErrors(errs);
      focusFirstError(errs);
    },
  });

  const onChange = (patch: Partial<MemberFormState>) => setForm((f) => ({ ...f, ...patch }));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const { payload, errors: errs } = formToPayload(form);
    setErrors(errs);
    focusFirstError(errs);
    if (payload) create.mutate(payload);
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="icon" aria-label="Back to members">
          <Link to="/members">
            <ArrowLeft />
          </Link>
        </Button>
        <h2 className="text-2xl font-semibold tracking-tight">Add member</h2>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Who is this?</CardTitle>
          <CardDescription>Only the display name is required. The e-Transfer name is how incoming payments find this member.</CardDescription>
        </CardHeader>
        <CardContent>
          <IdentityFields form={form} errors={errors} onChange={onChange} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Plan</CardTitle>
          <CardDescription>Leave a field empty to use the workspace default; it then follows any later change to the default.</CardDescription>
        </CardHeader>
        <CardContent>
          <PlanFields form={form} errors={errors} onChange={onChange} defaults={settings.data?.memberDefaults} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Emails and notes</CardTitle>
        </CardHeader>
        <CardContent>
          <EmailAndNotesFields form={form} errors={errors} onChange={onChange} />
        </CardContent>
      </Card>
      <p className="text-sm text-muted-foreground">
        A new member has no paid-through date yet. Payments (and opening balances) are recorded through the billing ledger, so every change to a due date stays in the history.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Adding…' : 'Add member'}
        </Button>
        <Button asChild variant="ghost">
          <Link to="/members">Cancel</Link>
        </Button>
        {create.isError && Object.keys(serverErrors(create.error)).length === 0 && (
          <span role="alert" className="text-sm text-destructive">
            {create.error.message}
          </span>
        )}
      </div>
    </form>
  );
}

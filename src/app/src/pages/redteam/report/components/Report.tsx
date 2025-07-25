import React from 'react';
import EnterpriseBanner from '@app/components/EnterpriseBanner';
import { callApi } from '@app/utils/api';
import ListAltIcon from '@mui/icons-material/ListAlt';
import PrintIcon from '@mui/icons-material/Print';
import WarningIcon from '@mui/icons-material/Warning';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Modal from '@mui/material/Modal';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import {
  type EvaluateResult,
  type ResultsFile,
  type SharedResults,
  type GradingResult,
  type ResultLightweightWithLabel,
  type EvaluateSummaryV2,
  isProviderOptions,
} from '@promptfoo/types';
import { convertResultsToTable } from '@promptfoo/util/convertEvalResultsToTable';
import FrameworkCompliance from './FrameworkCompliance';
import Overview from './Overview';
import ReportDownloadButton from './ReportDownloadButton';
import ReportSettingsDialogButton from './ReportSettingsDialogButton';
import RiskCategories from './RiskCategories';
import StrategyStats from './StrategyStats';
import TestSuites from './TestSuites';
import ToolsDialog from './ToolsDialog';
import { getPluginIdFromResult, getStrategyIdFromTest } from './shared';
import './Report.css';

const App: React.FC = () => {
  const [evalId, setEvalId] = React.useState<string | null>(null);
  const [evalData, setEvalData] = React.useState<ResultsFile | null>(null);
  const [selectedPromptIndex, setSelectedPromptIndex] = React.useState(0);
  const [isPromptModalOpen, setIsPromptModalOpen] = React.useState(false);
  const [isToolsDialogOpen, setIsToolsDialogOpen] = React.useState(false);

  const searchParams = new URLSearchParams(window.location.search);
  React.useEffect(() => {
    const fetchEvalById = async (id: string) => {
      const resp = await callApi(`/results/${id}`, {
        cache: 'no-store',
      });
      const body = (await resp.json()) as SharedResults;
      setEvalData(body.data);
    };

    if (searchParams) {
      const evalId = searchParams.get('evalId');
      if (evalId) {
        setEvalId(evalId);
        fetchEvalById(evalId);
      } else {
        // Need to fetch the latest evalId from the server
        const fetchLatestEvalId = async () => {
          try {
            const resp = await callApi('/results', { cache: 'no-store' });
            if (!resp.ok) {
              console.error('Failed to fetch recent evals');
              return;
            }
            const body = (await resp.json()) as { data: ResultLightweightWithLabel[] };
            if (body.data && body.data.length > 0) {
              const latestEvalId = body.data[0].evalId;
              setEvalId(latestEvalId);
              fetchEvalById(latestEvalId);
            } else {
              console.log('No recent evals found');
            }
          } catch (error) {
            console.error('Error fetching latest eval:', error);
          }
        };

        fetchLatestEvalId();
      }
    }
  }, []);

  const failuresByPlugin = React.useMemo(() => {
    if (!evalData) {
      return {};
    }

    const failures: Record<
      string,
      { prompt: string; output: string; gradingResult?: GradingResult; result?: EvaluateResult }[]
    > = {};
    evalData?.results.results.forEach((result) => {
      const pluginId = getPluginIdFromResult(result);
      if (!pluginId) {
        console.warn(`Could not get failures for plugin ${pluginId}`);
        return;
      }

      if (!result.success || !result.gradingResult?.pass) {
        if (!failures[pluginId]) {
          failures[pluginId] = [];
        }
        // Backwards compatibility for old evals that used 'query' instead of 'prompt'. 2024-12-12
        const injectVar = evalData.config.redteam?.injectVar ?? 'prompt';
        const injectVarValue =
          result.vars[injectVar]?.toString() || result.vars['query']?.toString();
        failures[pluginId].push({
          prompt: injectVarValue || result.prompt.raw,
          output: result.response?.output,
          gradingResult: result.gradingResult || undefined,
          result,
        });
      }
    });
    return failures;
  }, [evalData]);

  const passesByPlugin = React.useMemo(() => {
    if (!evalData) {
      return {};
    }

    const passes: Record<
      string,
      { prompt: string; output: string; gradingResult?: GradingResult; result?: EvaluateResult }[]
    > = {};
    evalData?.results.results.forEach((result) => {
      const pluginId = getPluginIdFromResult(result);
      if (!pluginId) {
        console.warn(`Could not get passes for plugin ${pluginId}`);
        return;
      }

      if (result.success && result.gradingResult?.pass) {
        if (!passes[pluginId]) {
          passes[pluginId] = [];
        }
        passes[pluginId].push({
          prompt:
            result.vars.query?.toString() || result.vars.prompt?.toString() || result.prompt.raw,
          output: result.response?.output,
          gradingResult: result.gradingResult || undefined,
          result,
        });
      }
    });
    return passes;
  }, [evalData]);

  const categoryStats = React.useMemo(() => {
    if (!evalData) {
      return {};
    }

    return evalData.results.results.reduce(
      (acc, row) => {
        const pluginId = getPluginIdFromResult(row);
        if (!pluginId) {
          return acc;
        }

        acc[pluginId] = acc[pluginId] || { pass: 0, total: 0, passWithFilter: 0 };
        acc[pluginId].total++;

        // Check if moderation tests failed but other tests passed - this indicates content was
        // flagged by moderation but would have passed otherwise
        const moderationPassed = row.gradingResult?.componentResults?.some(
          (result) => result.assertion?.type === 'moderation' && !result.pass,
        );

        if (row.success) {
          acc[pluginId].pass++;
          acc[pluginId].passWithFilter++; // Both regular and filtered pass counts increment
        } else if (moderationPassed) {
          acc[pluginId].passWithFilter++; // Only filtered pass count increments (partial success under moderation)
        }
        return acc;
      },
      {} as Record<string, { pass: number; total: number; passWithFilter: number }>,
    );
  }, [evalData]);

  const strategyStats = React.useMemo(() => {
    if (!failuresByPlugin || !passesByPlugin) {
      return {};
    }

    const stats: Record<string, { pass: number; total: number }> = {};

    // Process tests in failuresByPlugin (attack successes)
    Object.values(failuresByPlugin).forEach((tests) => {
      tests.forEach((test) => {
        const strategyId = getStrategyIdFromTest(test);

        if (!stats[strategyId]) {
          stats[strategyId] = { pass: 0, total: 0 };
        }

        stats[strategyId].pass += 1;
        stats[strategyId].total += 1;
      });
    });

    // Process tests in passesByPlugin (attack failures)
    Object.values(passesByPlugin).forEach((tests) => {
      tests.forEach((test) => {
        const strategyId = getStrategyIdFromTest(test);

        if (!stats[strategyId]) {
          stats[strategyId] = { pass: 0, total: 0 };
        }

        stats[strategyId].total += 1;
      });
    });

    return stats;
  }, [failuresByPlugin, passesByPlugin]);

  React.useEffect(() => {
    document.title = `Report: ${evalData?.config.description || evalId || 'Red Team'} | promptfoo`;
  }, [evalData, evalId]);

  if (!evalData || !evalId) {
    return <Box sx={{ width: '100%', textAlign: 'center' }}>Loading...</Box>;
  }

  if (!evalData.config.redteam) {
    return (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          padding: 3,
        }}
      >
        <Paper elevation={3} sx={{ padding: 4, maxWidth: 600, textAlign: 'center' }}>
          <WarningIcon color="warning" sx={{ fontSize: 60, marginBottom: 2 }} />
          <Typography variant="h4" mb={3}>
            Report unavailable
          </Typography>
          <Typography variant="body1">
            The {searchParams.get('evalId') ? 'selected' : 'latest'} evaluation results are not
            displayable in report format.
          </Typography>
          <Typography variant="body1">Please run a red team and try again.</Typography>
        </Paper>
      </Box>
    );
  }

  const prompts =
    (evalData.version >= 4
      ? evalData.prompts
      : (evalData.results as EvaluateSummaryV2).table.head.prompts) || [];
  const selectedPrompt = prompts[selectedPromptIndex];
  const tableData =
    (evalData.version >= 4
      ? convertResultsToTable(evalData).body
      : (evalData.results as EvaluateSummaryV2).table.body) || [];

  let tools = [];
  if (Array.isArray(evalData.config.providers) && isProviderOptions(evalData.config.providers[0])) {
    const providerTools = evalData.config.providers[0].config?.tools;
    // If providerTools exists, convert it to an array (if it's not already)
    // Otherwise, use an empty array
    tools = providerTools ? (Array.isArray(providerTools) ? providerTools : [providerTools]) : [];
  }

  const handlePromptChipClick = () => {
    setIsPromptModalOpen(true);
  };

  const handlePromptSelect = (index: number) => {
    setSelectedPromptIndex(index);
    setIsPromptModalOpen(false);
  };

  return (
    <Container maxWidth="xl">
      <Stack spacing={4} pb={8} pt={2}>
        {evalData.config.redteam && <EnterpriseBanner evalId={evalId || ''} />}
        <Card className="report-header" sx={{ position: 'relative' }}>
          <Box
            sx={{ position: 'absolute', top: 8, right: 8, display: 'flex' }}
            className="print-hide"
          >
            <Tooltip title="View all logs" placement="top">
              <IconButton
                sx={{ position: 'relative' }}
                aria-label="view all logs"
                onClick={(event) => {
                  const url = `/eval/${evalId}`;
                  if (event.ctrlKey || event.metaKey) {
                    window.open(url, '_blank');
                  } else {
                    window.location.href = url;
                  }
                }}
              >
                <ListAltIcon />
              </IconButton>
            </Tooltip>
            <ReportDownloadButton
              evalDescription={evalData.config.description || evalId}
              evalData={evalData}
            />
            <Tooltip
              title="Print this page (Ctrl+P) and select 'Save as PDF' for best results"
              placement="top"
            >
              <IconButton
                sx={{ position: 'relative' }}
                aria-label="print page"
                onClick={() => window.print()}
              >
                <PrintIcon />
              </IconButton>
            </Tooltip>
            <ReportSettingsDialogButton />
          </Box>
          <Typography variant="h4">
            <strong>LLM Risk Assessment</strong>
            {evalData.config.description && `: ${evalData.config.description}`}
          </Typography>
          <Typography variant="subtitle1" mb={2}>
            {new Date(evalData.createdAt).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </Typography>
          <Box className="report-details">
            {selectedPrompt && (
              <Chip
                size="small"
                label={
                  <>
                    <strong>Target:</strong> {selectedPrompt.provider}
                  </>
                }
                onClick={handlePromptChipClick}
                style={{ cursor: prompts.length > 1 ? 'pointer' : 'default' }}
              />
            )}
            <Tooltip
              title={
                selectedPrompt?.metrics?.tokenUsage?.total
                  ? `${selectedPrompt.metrics.tokenUsage.total.toLocaleString()} tokens`
                  : ''
              }
            >
              <Chip
                size="small"
                label={
                  <>
                    <strong>Depth:</strong>{' '}
                    {(
                      selectedPrompt?.metrics?.tokenUsage?.numRequests || tableData.length
                    ).toLocaleString()}{' '}
                    probes
                  </>
                }
              />
            </Tooltip>
            {selectedPrompt && selectedPrompt.raw !== '{{prompt}}' && (
              <Chip
                size="small"
                label={
                  <>
                    <strong>Prompt:</strong> &quot;
                    {selectedPrompt.raw.length > 40
                      ? `${selectedPrompt.raw.substring(0, 40)}...`
                      : selectedPrompt.raw}
                    &quot;
                  </>
                }
                onClick={handlePromptChipClick}
                style={{ cursor: prompts.length > 1 ? 'pointer' : 'default' }}
              />
            )}
            {tools.length > 0 && (
              <Chip
                size="small"
                label={
                  <>
                    <strong>Tools:</strong> {tools.length} available
                  </>
                }
                onClick={() => setIsToolsDialogOpen(true)}
                style={{ cursor: 'pointer' }}
              />
            )}
          </Box>
        </Card>
        <Overview categoryStats={categoryStats} plugins={evalData.config.redteam.plugins || []} />
        <StrategyStats
          strategyStats={strategyStats}
          failuresByPlugin={failuresByPlugin}
          passesByPlugin={passesByPlugin}
        />
        <RiskCategories
          categoryStats={categoryStats}
          strategyStats={strategyStats}
          evalId={evalId}
          failuresByPlugin={failuresByPlugin}
          passesByPlugin={passesByPlugin}
        />
        <TestSuites
          evalId={evalId}
          categoryStats={categoryStats}
          plugins={evalData.config.redteam.plugins || []}
        />
        <FrameworkCompliance categoryStats={categoryStats} strategyStats={strategyStats} />
      </Stack>
      <Modal
        open={isPromptModalOpen}
        onClose={() => setIsPromptModalOpen(false)}
        aria-labelledby="prompt-modal-title"
        sx={{
          '& .MuiModal-root': {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          },
          '& .MuiBox-root': {
            width: '80%',
            maxWidth: 800,
            maxHeight: '90vh',
            overflowY: 'auto',
          },
        }}
      >
        <Box
          sx={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 400,
            bgcolor: 'background.paper',
            boxShadow: 24,
            p: 4,
          }}
        >
          <Typography id="prompt-modal-title" variant="h6" component="h2" gutterBottom>
            View results for...
          </Typography>
          <List>
            {prompts.map((prompt, index) => (
              // @ts-ignore
              <ListItem
                key={index}
                button
                onClick={() => handlePromptSelect(index)}
                selected={index === selectedPromptIndex}
              >
                <ListItemText
                  primary={`${prompt.provider}`}
                  secondary={
                    <pre>
                      {prompt.raw.length > 100 && prompts.length > 1
                        ? `${prompt.raw.substring(0, 100)}...`
                        : prompt.raw}
                    </pre>
                  }
                />
              </ListItem>
            ))}
          </List>
        </Box>
      </Modal>
      <ToolsDialog
        open={isToolsDialogOpen}
        onClose={() => setIsToolsDialogOpen(false)}
        tools={tools}
      />
    </Container>
  );
};

export default App;

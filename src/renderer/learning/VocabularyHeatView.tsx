import type { HeatStatistic } from '../../shared/contracts';

export interface VocabularyHeatViewProps {
    statistics: readonly HeatStatistic[];
}

function compareText(left: string, right: string): number {
    if (left < right)
        return -1;
    if (left > right)
        return 1;
    return 0;
}

export function rankHeatStatistics(
    statistics: readonly HeatStatistic[]
): HeatStatistic[] {
    return [...statistics].sort((left, right) => (
        right.occurrenceCount - left.occurrenceCount
        || right.recentOccurrenceCount - left.recentOccurrenceCount
        || compareText(right.lastUsedAt, left.lastUsedAt)
        || compareText(left.normalizedSource, right.normalizedSource)
        || compareText(left.sourceLanguage, right.sourceLanguage)
        || compareText(left.targetLanguage, right.targetLanguage)
    ));
}

export function VocabularyHeatView({ statistics }: VocabularyHeatViewProps) {
    return (
        <table aria-label="Vocabulary heat">
            <thead>
                <tr>
                    <th scope="col">Source</th>
                    <th scope="col">Normalized</th>
                    <th scope="col">Languages</th>
                    <th scope="col">Count</th>
                    <th scope="col">Recent</th>
                </tr>
            </thead>
            <tbody>
                {rankHeatStatistics(statistics).map((item) => (
                    <tr key={`${item.normalizedSource}:${item.sourceLanguage}:${item.targetLanguage}`}>
                        <td>{item.sourceText}</td>
                        <td>{item.normalizedSource}</td>
                        <td>{item.sourceLanguage}{item.targetLanguage}</td>
                        <td>{item.occurrenceCount}</td>
                        <td>{item.recentOccurrenceCount}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

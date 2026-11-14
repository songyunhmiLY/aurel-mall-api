import { IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';

export class StepSimulationDto {
  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(527040)
  byMinutes?: number;
}
